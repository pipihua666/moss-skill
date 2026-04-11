import {
  ensureAvatarServer,
  ensureBridgeServer,
  openBrowser,
  request
} from "./memory-runtime.mjs";

async function main() {
  const person = process.argv.slice(2).join(" ").trim();

  if (!person) {
    console.error("缺少人物名称。用法：npm run user -- \"奶奶\"");
    process.exit(1);
  }

  try {
    await ensureAvatarServer();
    const bridgeServerUrl = await ensureBridgeServer();
    const launchResponse = await request(`${bridgeServerUrl}/api/memory/launch`, {
      method: "POST",
      body: {
        personId: person
      },
      timeout: 5000
    });

    if (!launchResponse.ok || !launchResponse.json?.avatarUrl) {
      console.error(launchResponse.json?.error ?? "人物回忆页准备好了，但桥服务没把地址递出来。");
      process.exit(1);
    }

    const url = launchResponse.json.avatarUrl;
    const browser = openBrowser(url);
    browser.on("error", (error) => {
      console.error(`人物回忆页已准备好，但浏览器没打开：${error.message}`);
      console.error(`请手动访问：${url}`);
      process.exit(1);
    });

    browser.unref();
    console.log(`已尝试打开 ${url}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

void main();
