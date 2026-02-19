#!/bin/bash

# Kill any existing processes
echo "Killing existing processes..."
pkill -f "node.*dev\|vite" 2>/dev/null || true

# Wait a moment for processes to terminate
sleep 2

# Start the server
echo "Starting server..."
cd server
npm run dev > server.log 2>&1 &
SERVER_PID=$!
cd ..

# Wait for server to start
sleep 3

# Start the frontend
echo "Starting frontend..."
cd web
npm run dev > frontend.log 2>&1 &
FRONTEND_PID=$!
cd ..

echo "Server PID: $SERVER_PID"
echo "Frontend PID: $FRONTEND_PID"
echo "Server logs: server.log"
echo "Frontend logs: web/frontend.log"
echo "Use 'kill $SERVER_PID $FRONTEND_PID' to stop the servers"