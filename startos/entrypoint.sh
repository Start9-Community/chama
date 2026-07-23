#!/bin/sh
set -eu

pids=""
stop() {
  for pid in $pids; do kill "$pid" 2>/dev/null || true; done
}
trap stop INT TERM EXIT

client=1
for port in 8787 8788 8789; do
  data_dir="/data/client-$client"
  mkdir -p "$data_dir"
  chama-fedimint-bridge --data-dir "$data_dir" serve --bind "127.0.0.1:$port" &
  pids="$pids $!"
  client=$((client + 1))
done

nginx -g 'daemon off;' &
nginx_pid=$!
pids="$pids $nginx_pid"
wait "$nginx_pid"
