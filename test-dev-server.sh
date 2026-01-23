#!/bin/bash
# Quick test script to start dev server and test endpoints

echo "Starting Wrangler dev server..."
npm run dev &
DEV_PID=$!

# Wait for server to start
echo "Waiting for server to start..."
sleep 5

# Test endpoints
echo -e "\n=== Testing root endpoint ==="
curl -s http://localhost:8787/ | jq . || echo "Root endpoint test"

echo -e "\n=== Testing health endpoint ==="
curl -s http://localhost:8787/health | jq . || echo "Health endpoint test"

# Cleanup
echo -e "\nStopping dev server..."
kill $DEV_PID
