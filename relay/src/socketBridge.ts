import { randomUUID } from 'crypto';
import type { Server, Socket } from 'socket.io';
import type { TunnelManager, TunnelMessage } from './tunnel.js';

/**
 * Bridges dashboard Socket.IO connections with the tunnel to the local machine.
 *
 * Dashboard → Relay (Socket.IO) → Tunnel (WS) → Local Machine
 * Local Machine → Tunnel (WS) → Relay (Socket.IO) → Dashboard
 */
export function setupSocketBridge(io: Server, tunnel: TunnelManager): void {
  // Socket.IO authentication — delegate to local server via tunnel
  io.use(async (socket, next) => {
    const cookieHeader = socket.handshake.headers.cookie as string || '';
    try {
      const result = await tunnel.sendHttpRequest({
        type: 'http:request',
        id: randomUUID(),
        method: 'GET',
        path: '/api/auth/check',
        headers: { cookie: cookieHeader },
        body: null,
      });
      if (result.status === 200) return next();
      return next(new Error('Authentication required'));
    } catch {
      return next(new Error('Tunnel not connected'));
    }
  });

  // Handle messages from tunnel (local machine → dashboard)
  tunnel.onMessage((msg: TunnelMessage) => {
    if (msg.type === 'socket:s2c') {
      // Broadcast to all connected dashboard clients
      const sockets = io.sockets.sockets.size;
      console.log(`[SocketBridge] Broadcasting ${msg.event} to ${sockets} clients`);
      io.emit(msg.event as string, ...(msg.args as unknown[] || []));
    } else if (msg.type === 'socket:s2c:room') {
      // Emit to a specific room
      const room = io.sockets.adapter.rooms.get(msg.room as string);
      const roomSize = room?.size || 0;
      console.log(`[SocketBridge] Emitting ${msg.event} to room ${msg.room} (${roomSize} clients)`);
      io.to(msg.room as string).emit(msg.event as string, ...(msg.args as unknown[] || []));
    }
  });

  // Handle dashboard client connections
  io.on('connection', (socket: Socket) => {
    console.log(`[SocketBridge] Client connected: ${socket.id}`);
    socket.on('disconnect', (reason) => {
      console.log(`[SocketBridge] Client disconnected: ${socket.id} (${reason})`);
    });

    // Forward client-to-server events through tunnel
    socket.on('agent:join', (agentId: string) => {
      console.log(`[SocketBridge] Client ${socket.id} joining room agent:${agentId}`);
      socket.join(`agent:${agentId}`);
      tunnel.send({
        type: 'socket:c2s',
        event: 'agent:join',
        args: [agentId],
      });
    });

    socket.on('agent:leave', (agentId: string) => {
      socket.leave(`agent:${agentId}`);
      tunnel.send({
        type: 'socket:c2s',
        event: 'agent:leave',
        args: [agentId],
      });
    });

    socket.on('agent:send', (data: { agentId: string; text: string }) => {
      tunnel.send({
        type: 'socket:c2s',
        event: 'agent:send',
        args: [data],
      });
    });

    socket.on('agent:interrupt', (agentId: string) => {
      tunnel.send({
        type: 'socket:c2s',
        event: 'agent:interrupt',
        args: [agentId],
      });
    });

    // Forward PTY terminal events through tunnel
    socket.on('terminal:open', (data: { agentId: string; cols?: number; rows?: number; initialCommand?: string }) => {
      tunnel.send({ type: 'socket:c2s', event: 'terminal:open', args: [data] });
    });

    socket.on('terminal:input', (data: { agentId: string; data: string }) => {
      tunnel.send({ type: 'socket:c2s', event: 'terminal:input', args: [data] });
    });

    socket.on('terminal:resize', (data: { agentId: string; cols: number; rows: number }) => {
      tunnel.send({ type: 'socket:c2s', event: 'terminal:resize', args: [data] });
    });

    socket.on('terminal:close', (agentId: string) => {
      tunnel.send({ type: 'socket:c2s', event: 'terminal:close', args: [agentId] });
    });
  });
}
