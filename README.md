# Air Safety Monitor

Confined-space air safety monitor built on an ESP32 (VIT Chennai, Embedded Systems, Sem 5).

- **`firmware/AirSafetyMonitor/`** — Arduino sketch for the ESP32: MQ135 (gas), BMP280 (temperature/pressure),
  DS3231 (clock), LDR, HC-SR04 + servo scan, OLED, status LED, buzzer and relay.
  Set `WIFI_SSID`, `WIFI_PASSWORD` and `SERVER_URL` before flashing.
- **`web/`** — a **simulated** dashboard (Next.js on Vercel). Its readings are generated in the browser by
  `web/lib/simulator.js`, driven by a hidden remote page; it does not receive data from the ESP32.
  Hashes of the simulated batches are anchored on the Polygon Amoy testnet. See `web/README.md`.
