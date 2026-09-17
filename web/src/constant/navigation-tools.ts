import { FileText } from "lucide-react";

export const navigationTools = [
    {
        slug: "prompts",
        label: "提示词库",
        icon: FileText,
    },
] as const;

export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];
