import { createApp } from "./core/index.js";

const app = createApp();
const port = Number(process.env.PORT || 8787);

app.listen(port, () => {
  console.log(`Discuz server listening on http://localhost:${port}`);
});
