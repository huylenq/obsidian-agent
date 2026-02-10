import React, { useEffect, useRef } from "react";
import { MarkdownRenderer, Component, App } from "obsidian";
import { renderDotBlocks } from "./dotRenderer";

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
    // This preserves the line breaks that Claude sends
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
      if (!cancelled) renderDotBlocks(container);
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

  return <div ref={containerRef} className={className} />;
}
