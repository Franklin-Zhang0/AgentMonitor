import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;
const joinedAgents = new Set<string>();

export function getSocket(): Socket {
  if (!socket) {
    socket = io('/', {
      transports: ['polling', 'websocket'],
      withCredentials: true,
    });

    socket.on('connect', () => {
      console.log('[Socket] Connected:', socket?.id);
    });
    socket.on('disconnect', (reason) => {
      console.log('[Socket] Disconnected:', reason);
    });
    socket.on('connect_error', (err) => {
      console.error('[Socket] Connection error:', err.message);
    });
    socket.on('connect', () => {
      // Rejoin all agent rooms after reconnect (important for relay/network drops).
      for (const agentId of joinedAgents) {
        socket?.emit('agent:join', agentId);
      }
    });
  }
  return socket;
}

export function joinAgent(agentId: string): void {
  joinedAgents.add(agentId);
  getSocket().emit('agent:join', agentId);
}

export function leaveAgent(agentId: string): void {
  joinedAgents.delete(agentId);
  getSocket().emit('agent:leave', agentId);
}

export function sendMessage(agentId: string, text: string): void {
  getSocket().emit('agent:send', { agentId, text });
}

export function interruptAgent(agentId: string): void {
  getSocket().emit('agent:interrupt', agentId);
}
