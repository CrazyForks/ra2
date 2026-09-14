import { Component, type ReactNode } from 'react';

export class UiErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="panel" role="alert">
        <h3>界面出现错误</h3>
        <pre>{this.state.error}</pre>
        <button type="button" onClick={() => window.location.reload()}>
          重新加载页面
        </button>
      </section>
    );
  }
}
