# D2 LAN positive control — legacy rig :8791 (--feature e2ee=false), 2026-09-02 11:31 IDT

Capture: sudo tcpdump -i en0 -s 0 -w positive-control.pcap 'tcp port 8791' → 83 packets captured, 805 filtered, 0 dropped.
Decode: tshark -d tcp.port==8791,http; websocket.payload / http.file_data are hex, converted back to bytes before grep.

ws_frames=8  http_bodies=6
WS decoded, marker "type":  → 1 hit  (session_list, cache_ready, host_pressure, register all in clear)
HTTP decoded, marker "type": → 0 hits — WS-only field, unfit for the REST leg (see PLAN-D §14 correction)
HTTP decoded, "conversations": → 1, "sessions": → 1, "serverIdentityKey": → 2  (REST leg control PASS)

Conclusion: the capture+decode pipeline demonstrably sees plaintext on both legs, so a zero on the sealed :8790 run is meaningful.
