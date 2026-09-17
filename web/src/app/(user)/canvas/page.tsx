import { redirect } from "next/navigation";

// 画布列表已并入「我的画布」（/）。
export default function CanvasListRedirect() {
    redirect("/");
}
