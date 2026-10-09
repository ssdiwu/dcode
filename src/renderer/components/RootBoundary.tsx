// 根错误边界：原型阶段的渲染崩溃要留下组件栈证据，不静默白屏。

import { Component, type ReactNode } from "react";

import { useT } from "../i18n";

function RenderFailure() {
  const t = useT();
  return <div role="alert" className="p-6 text-ui-base text-foreground">{t("app.renderError")}</div>;
}

export class RootBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error("ROOT_CRASH", { name: error.name }, info.componentStack ?? "");
  }

  render() {
    if (this.state.error) {
      return <RenderFailure />;
    }
    return this.props.children;
  }
}
