---
title: redtap-space
emoji: 🟠
colorFrom: red
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

Ingest service for the redtap pool: accepts observation batches from the
redtap browser extension, deduplicates them, and appends them to the private
immutable Bucket log (osolmaz/redtap-data).
