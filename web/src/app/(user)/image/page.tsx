import { redirect } from "next/navigation";

// 生图工作台已下线（PRD 第 10 节）：能力经画布节点与 CLI / API / MCP 使用。原页面源码保留在 legacy-page.tsx，不参与路由。
export default function RetiredPageRedirect() {
    redirect("/");
}
