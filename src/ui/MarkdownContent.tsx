import React, { useEffect, useRef, useCallback } from "react";
import { MarkdownRenderer, Component, App } from "obsidian";
import { renderDotBlocks } from "./dotRenderer";
import { attachLatexCopyButtons } from "./copyButtons";

// Obsidian exposes `app` as a global
declare const app: App;

interface MarkdownContentProps {
  content: string;
  className?: string;
}

/**
 * React component that renders markdown using Obsidian's MarkdownRenderer
 */
export function MarkdownContent({ content, className }: MarkdownContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const componentRef = useRef<Component | null>(null);

  // Handle clicks on internal links (wiki-style [[links]])
  const handleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const link = target.closest("a.internal-link");
    if (!link) return;

    event.preventDefault();
    const href = link.getAttribute("data-href") || link.getAttribute("href");
    if (!href) return;

    // Open the linked note in Obsidian
    app.workspace.openLinkText(href, "", event.ctrlKey || event.metaKey);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Clear previous content
    container.empty();

    // Create a dummy Component for MarkdownRenderer lifecycle management
    if (!componentRef.current) {
      componentRef.current = new Component();
      componentRef.current.load();
    }

    // Convert single newlines to markdown line breaks (two spaces + newline)
    // Preserve line breaks emitted by the agent.
    const formattedContent = content.replace(/\n/g, "  \n");

    // Render markdown, then post-process DOT code blocks into SVG
    let cancelled = false;
    MarkdownRenderer.render(
      app,
      formattedContent,
      container,
      "",
      componentRef.current
    ).then(() => {
      if (!cancelled) {
        renderDotBlocks(container);
        attachLatexCopyButtons(container, content);
      }
    });

    return () => {
      cancelled = true;
      // Cleanup on unmount
      if (componentRef.current) {
        componentRef.current.unload();
        componentRef.current = null;
      }
    };
  }, [content]);

  return <div ref={containerRef} className={className} onClick={handleClick} />;
}
