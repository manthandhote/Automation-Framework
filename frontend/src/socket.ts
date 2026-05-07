import { io } from 'socket.io-client';

const API_BASE = 'http://localhost:4200';

// Create a single socket instance
export const socket = io(API_BASE, {
  autoConnect: true,
  reconnection: true,
  reconnectionDelay: 1000
});

// For debugging
socket.on('connect', () => {
  console.log('[SOCKET] Connected to engine:', socket.id);
});

socket.on('disconnect', () => {
  console.log('[SOCKET] Disconnected');
});
