"""
Backend AISStream Module - Live AIS Vessel Tracking Client
===========================================================
Connects to AISStream API via secure WebSocket (wss://stream.aisstream.io/v0/connect),
subscribes to global AIS position updates, parses incoming messages,
normalizes vessel data, and provides auto-reconnection logic with status callbacks.
"""

import os
import json
import time
import asyncio
import threading
import logging
from datetime import datetime, timezone
from typing import Dict, Any, Callable, Optional

import websockets

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("AISStream")

AISSTREAM_WS_URL = "wss://stream.aisstream.io/v0/connect"


class AISStreamClient:
    """
    AISStream WebSocket Client with automatic reconnection,
    MMSI data normalization, and state callback support.
    """

    def __init__(self, api_key: Optional[str] = None,
                 on_update: Optional[Callable[[Dict[str, Any]], None]] = None,
                 on_status: Optional[Callable[[str, str], None]] = None):
        self.api_key = api_key or os.environ.get("AISSTREAM_API_KEY", "")
        self.on_update = on_update
        self.on_status = on_status
        
        self.running = False
        self.status = "disconnected"  # connected, reconnecting, disconnected, waiting_key, error
        self.status_message = "Not connected"
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        
        # Internal cache of vessel static data (MMSI -> {Name, IMO, Type})
        self.vessel_cache: Dict[str, Dict[str, Any]] = {}

    def set_api_key(self, api_key: str):
        """Update API Key dynamically and restart connection if running."""
        self.api_key = api_key.strip()
        logger.info(f"API key updated: {self.api_key[:6]}...")
        if self.running:
            self.stop()
            self.start()

    def _update_status(self, status: str, message: str = ""):
        self.status = status
        self.status_message = message
        logger.info(f"AISStream Status: {status} - {message}")
        if self.on_status:
            try:
                self.on_status(status, message)
            except Exception as e:
                logger.error(f"Error in on_status callback: {e}")

    def start(self):
        """Start the AISStream background thread."""
        if self.running:
            return
        self.running = True
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()

    def stop(self):
        """Stop the AISStream background connection."""
        self.running = False
        if self._loop and self._loop.is_running():
            self._loop.call_soon_threadsafe(self._loop.stop)
        self._update_status("disconnected", "Stopped by user")

    def _run_loop(self):
        """Thread worker running asyncio loop."""
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._connect_and_listen())
        except Exception as e:
            logger.error(f"Event loop exception: {e}")
        finally:
            self._loop.close()

    async def _connect_and_listen(self):
        """Main async loop with auto-reconnection backoff."""
        backoff_seconds = 2

        while self.running:
            if not self.api_key:
                self._update_status("waiting_key", "Waiting for valid AISStream API Key")
                await asyncio.sleep(5)
                continue

            self._update_status("connecting", "Connecting to stream.aisstream.io...")

            subscription_msg = {
                "APIKey": self.api_key,
                "BoundingBoxes": [[[-90, -180], [90, 180]]]
            }

            try:
                async with websockets.connect(
                    AISSTREAM_WS_URL,
                    ping_interval=20,
                    ping_timeout=10,
                    close_timeout=5
                ) as ws:
                    # Send subscription request
                    await ws.send(json.dumps(subscription_msg))
                    self._update_status("connected", "Live AISStream connected")
                    backoff_seconds = 2  # Reset backoff on successful connection

                    async for raw_msg in ws:
                        if not self.running:
                            break
                        self._handle_raw_message(raw_msg)

            except websockets.exceptions.InvalidStatusCode as e:
                msg = f"HTTP Error {e.status_code}: Check your AISStream API Key"
                self._update_status("error", msg)
                await asyncio.sleep(10)
            except Exception as e:
                if self.running:
                    self._update_status("reconnecting", f"Connection lost ({str(e)}). Reconnecting in {backoff_seconds}s...")
                    await asyncio.sleep(backoff_seconds)
                    backoff_seconds = min(backoff_seconds * 2, 60)

    def _handle_raw_message(self, raw_msg: str):
        """Parse raw AISStream JSON message and emit vessel update."""
        try:
            data = json.loads(raw_msg)
            msg_type = data.get("MessageType", "")
            meta = data.get("MetaData", {})
            message = data.get("Message", {})

            mmsi = str(meta.get("MMSI") or meta.get("mmsi") or "")
            if not mmsi or mmsi == "0":
                return

            lat = meta.get("latitude")
            lng = meta.get("longitude")
            ship_name = (meta.get("ShipName") or "").strip()
            time_utc = meta.get("time_utc") or datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

            # Extract report specific values
            sog = None
            cog = None
            heading = None
            imo = None
            vessel_type = None

            if msg_type in ("PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport"):
                rep = message.get(msg_type, {})
                sog = rep.get("Sog")
                cog = rep.get("Cog")
                heading = rep.get("TrueHeading")
                if lat is None:
                    lat = rep.get("Latitude")
                if lng is None:
                    lng = rep.get("Longitude")
            elif msg_type == "ShipStaticData":
                static_data = message.get("ShipStaticData", {})
                if not ship_name:
                    ship_name = (static_data.get("Name") or "").strip()
                imo = static_data.get("ImoNumber")
                vessel_type = static_data.get("Type")

            # Update internal vessel cache
            cache_entry = self.vessel_cache.setdefault(mmsi, {})
            if ship_name:
                cache_entry["name"] = ship_name
            if imo:
                cache_entry["imo"] = imo
            if vessel_type is not None:
                cache_entry["type"] = vessel_type

            # Fill missing static details from cache if available
            final_name = cache_entry.get("name") or ship_name or f"Vessel {mmsi}"
            final_imo = cache_entry.get("imo") or imo or "N/A"
            final_type = cache_entry.get("type") if cache_entry.get("type") is not None else "Unspecified"

            # Heading 511 in AIS standard means "not available"
            if heading == 511 or heading is None:
                heading = cog if (cog is not None and cog < 360) else 0

            # Normalize valid coordinate position updates
            if lat is not None and lng is not None:
                vessel_update = {
                    "mmsi": mmsi,
                    "name": final_name,
                    "lat": float(lat),
                    "lng": float(lng),
                    "speed": float(sog) if sog is not None else 0.0,
                    "course": float(cog) if cog is not None else 0.0,
                    "heading": float(heading) if heading is not None else 0.0,
                    "timestamp": str(time_utc),
                    "imo": str(final_imo),
                    "type": str(final_type)
                }

                if self.on_update:
                    self.on_update(vessel_update)

        except Exception as e:
            logger.debug(f"Message parsing error: {e}")
