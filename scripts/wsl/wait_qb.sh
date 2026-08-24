#!/bin/bash
while pgrep -f 'quality_battery.py' > /dev/null 2>&1; do
  sleep 5
done
echo "QUALITY BATTERY FINISHED"
cat /tmp/qb.log 2>/dev/null || true
