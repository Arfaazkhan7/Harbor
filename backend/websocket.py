"""
Backend WebSocket Module - Browser Frontend Broadcaster
======================================================
Manages WebSocket server endpoint for browser clients (frontend/js/ships.js).
Caches active vessel updates by MMSI and broadcasts live AIS vessel position
updates and connection status events in real time.
"""

import json
import asyncio
import threading
import logging
from typing import Dict, Set, Any, Optional
import websockets

logger = logging.getLogger("WebSocketServer")

DEFAULT_HOST = "0.0.0.0"
DEFAULT_WS_PORT = 5001


class FrontendWebSocketServer:
    """
    WebSocket server broadcasting live AIS vessel updates to connected browser clients.
    """

    def __init__(self, host: str = DEFAULT_HOST, port: int = DEFAULT_WS_PORT):
        self.host = host
        self.port = port
        self.clients: Set[websockets.WebSocketServerProtocol] = set()
        self.vessels_cache: Dict[str, Dict[str, Any]] = {}
        self.current_status = "disconnected"
        self.current_status_msg = "Initializing system"
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._server = None

    def start(self):
        """Start the WebSocket broadcast server in a background thread."""
        thread = threading.Thread(target=self._run_server, daemon=True)
        thread.start()
        logger.info(f"WebSocket Broadcaster thread started on port {self.port}")

    def _run_server(self):
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        
        async def main():
            self._server = await websockets.serve(
                self._client_handler,
                self.host,
                self.port
            )
            logger.info(f"WebSocket Broadcaster listening on ws://127.0.0.1:{self.port}")
            await self._server.wait_closed()

        try:
            self._loop.run_until_complete(main())
        except Exception as e:
            logger.error(f"WebSocket server error: {e}")
        finally:
            self._loop.close()

    async def _client_handler(self, websocket, path=None):
        """Handle incoming browser client connections."""
        self.clients.add(websocket)
        logger.info(f"Browser client connected ({len(self.clients)} total)")

        try:
            # 1. Send initial status message
            status_msg = {
                "type": "status_update",
                "status": self.current_status,
                "message": self.current_status_msg,
                "cachedCount": len(self.vessels_cache)
            }
            await websocket.send(json.dumps(status_msg))

            # 2. Send initial snapshot of all currently cached active vessels
            if self.vessels_cache:
                snapshot_msg = {
                    "type": "initial_snapshot",
                    "vessels": list(self.vessels_cache.values())
                }
                await websocket.send(json.dumps(snapshot_msg))

            # 3. Listen for client incoming messages (e.g. ping/pong, set_api_key)
            async for message in websocket:
                try:
                    payload = json.loads(message)
                    # Handle actions if sent from frontend
                    if payload.get("action") == "ping":
                        await websocket.send(json.dumps({"type": "pong"}))
                except Exception:
                    pass

        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            self.clients.remove(websocket)
            logger.info(f"Browser client disconnected ({len(self.clients)} remaining)")

    def update_vessel(self, vessel_data: Dict[str, Any]):
        """Update cached vessel data and broadcast to connected clients."""
        mmsi = vessel_data.get("mmsi")
        if not mmsi:
            return

        self.vessels_cache[mmsi] = vessel_data

        msg = json.dumps({
            "type": "ship_update",
            "data": vessel_data
        })
        self.broadcast(msg)

    def update_status(self, status: str, message: str):
        """Update connection status and broadcast to clients."""
        self.current_status = status
        self.current_status_msg = message

        msg = json.dumps({
            "type": "status_update",
            "status": status,
            "message": message,
            "cachedCount": len(self.vessels_cache)
        })
        self.broadcast(msg)

    def broadcast(self, message_str: str):
        """Send message string to all active client connections asynchronously."""
        if not self.clients or not self._loop:
            return

        async def _async_send():
            dead_clients = set()
            for ws in list(self.clients):
                try:
                    await ws.send(message_str)
                except Exception:
                    dead_clients.add(ws)
            if dead_clients:
                self.clients.difference_update(dead_clients)

        asyncio.run_coroutine_threadsafe(_async_send(), self._loop)
