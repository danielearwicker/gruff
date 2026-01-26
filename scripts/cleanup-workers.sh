#!/bin/bash
# Cleanup orphaned wrangler/workerd processes and free port 8787

echo "Checking for orphaned wrangler/workerd processes..."

# Find and display processes
PROCS=$(ps aux | grep -E 'wrangler|workerd|miniflare' | grep -v grep)

if [ -z "$PROCS" ]; then
    echo "No orphaned processes found."
else
    echo "Found processes:"
    echo "$PROCS"
    echo ""
    echo "Killing processes..."

    # Kill all matching processes
    pkill -9 -f 'workerd' 2>/dev/null
    pkill -9 -f 'wrangler dev' 2>/dev/null
    pkill -9 -f 'miniflare' 2>/dev/null

    sleep 1
    echo "Done."
fi

# Check port 8787
echo ""
echo "Checking port 8787..."
PORT_CHECK=$(lsof -i :8787 2>/dev/null)

if [ -z "$PORT_CHECK" ]; then
    echo "Port 8787 is free."
else
    echo "Port 8787 still in use:"
    echo "$PORT_CHECK"
    echo ""
    echo "Force killing process on port 8787..."
    lsof -ti :8787 | xargs -r kill -9 2>/dev/null
    sleep 1
    echo "Done."
fi
