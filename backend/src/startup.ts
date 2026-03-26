export function explainServerListenError(error: NodeJS.ErrnoException, port: number): string | null {
  if (error.code === 'EADDRINUSE') {
    return `❌ Port ${port} is already in use. Another backend instance is probably still running. Stop the existing process or start this instance with a different PORT.`;
  }

  if (error.code === 'EACCES') {
    return `❌ Cannot bind to port ${port} due to insufficient permissions. Use a higher port or start the process with the required privileges.`;
  }

  return null;
}
