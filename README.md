# Baram Cloud Relay Server V10.73

BTC/USDT is routed through the cloud server using a shared Binance WebSocket feed with cache, heartbeat, reconnect, and REST snapshot backup.

Other symbols use Yahoo delayed chart relay:
- Nasdaq: NQ=F
- Gold: GC=F
- Silver: SI=F
- Oil: CL=F
- Hang Seng: ^HSI

No fake candles are generated. If data is unavailable, the server reports a status/error and keeps the last valid data.
