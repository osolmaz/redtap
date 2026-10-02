import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openBucketLog } from "./bucket-log.js";

const hubToken = process.env.HF_TOKEN ?? "";
const poolToken = process.env.POOL_TOKEN ?? "";
if (hubToken === "" || poolToken === "") {
  console.error("redtap-space requires HF_TOKEN and POOL_TOKEN secrets");
  process.exit(78);
}

const log = await openBucketLog({ accessToken: hubToken });
const app = createApp({ poolToken, hubToken }, log);

const port = Number(process.env.PORT ?? 7860);
serve({ fetch: app.fetch, port }, () => {
  console.log(`redtap-space listening on :${port}`);
});
