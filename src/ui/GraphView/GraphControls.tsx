/**
 * HUD-style overlay settings panel, mimicking Obsidian's built-in graph controls.
 * Uses native Obsidian CSS classes (.graph-controls, .setting-item, etc.) for
 * consistent look-and-feel.
 */

import React, { useState } from "react";
import { setIcon } from "obsidian";
import type { GraphViewSettings } from "@/types";

interface GraphControlsProps {
  settings: GraphViewSettings;
  onSettingsChange: (partial: Partial<GraphViewSettings>) => void;
  onRefresh: () => void;
  isLoading: boolean;
}

/** Tiny wrapper: renders an Obsidian icon into a <span> via setIcon(). */
function ObsidianIcon({ name }: { name: string }) {
  const ref = React.useCallback(
    (el: HTMLSpanElement | null) => {
      if (el) {
        el.empty();
        setIcon(el, name);
      }
    },
    [name],
  );
  return <span ref={ref} style={{ display: "contents" }} />;
}

export function GraphControls({ settings, onSettingsChange, onRefresh, isLoading }: GraphControlsProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className={`graph-controls${open ? "" : " is-close"}`}>
      {/* Gear button (visible when closed) */}
      <div
        className="graph-controls-button mod-open clickable-icon"
        onClick={() => setOpen(true)}
        aria-label="Open graph settings"
      >
        <ObsidianIcon name="settings" />
      </div>

      {/* Close button (visible when open) */}
      <div
        className="graph-controls-button mod-close clickable-icon"
        onClick={() => setOpen(false)}
        aria-label="Close graph settings"
      >
        <ObsidianIcon name="x" />
      </div>

      {/* Refresh button (in reset position, visible when open) */}
      <div
        className={`graph-controls-button mod-reset clickable-icon${isLoading ? " mod-animate" : ""}`}
        onClick={onRefresh}
        aria-label="Refresh graph"
      >
        <ObsidianIcon name="refresh-cw" />
      </div>

      {/* Settings section */}
      <div className="graph-control-section">
        <div className="tree-item-children">
          {/* Link depth slider */}
          <div className="setting-item mod-slider">
            <div className="setting-item-info">
              <div className="setting-item-name">Link depth</div>
            </div>
            <div className="setting-item-control">
              <input
                type="range"
                min={1}
                max={3}
                step={1}
                value={settings.linkDepth}
                onChange={(e) => onSettingsChange({ linkDepth: parseInt(e.target.value) as 1 | 2 | 3 })}
              />
            </div>
          </div>

          {/* Similarity threshold slider */}
          <div className="setting-item mod-slider">
            <div className="setting-item-info">
              <div className="setting-item-name">Similarity</div>
            </div>
            <div className="setting-item-control">
              <input
                type="range"
                min={0.3}
                max={0.8}
                step={0.05}
                value={settings.similarityThreshold}
                onChange={(e) => onSettingsChange({ similarityThreshold: parseFloat(e.target.value) })}
              />
            </div>
          </div>

          {/* Show link edges toggle */}
          <div className="setting-item mod-toggle">
            <div className="setting-item-info">
              <div className="setting-item-name">Link edges</div>
            </div>
            <div className="setting-item-control">
              <div
                className={`checkbox-container${settings.showLinkEdges ? " is-enabled" : ""}`}
                onClick={() => onSettingsChange({ showLinkEdges: !settings.showLinkEdges })}
              />
            </div>
          </div>

          {/* Show similarity edges toggle */}
          <div className="setting-item mod-toggle">
            <div className="setting-item-info">
              <div className="setting-item-name">Similarity edges</div>
            </div>
            <div className="setting-item-control">
              <div
                className={`checkbox-container${settings.showSimilarityEdges ? " is-enabled" : ""}`}
                onClick={() => onSettingsChange({ showSimilarityEdges: !settings.showSimilarityEdges })}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
