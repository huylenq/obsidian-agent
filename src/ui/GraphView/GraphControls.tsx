/**
 * HUD-style overlay settings panel, mimicking Obsidian's built-in graph controls.
 * Uses native Obsidian CSS classes (.graph-controls, .setting-item, etc.) for
 * consistent look-and-feel. Organized into collapsible sections like the
 * built-in graph view (Filters, Forces).
 *
 * The Filters section has a dock/undock button: when undocked, the two filter
 * sliders float as a compact HUD overlay on the graph canvas.
 */

import React, { useState, useRef, useCallback } from "react";
import { setIcon } from "obsidian";
import type { GraphViewSettings, PinnedNodeConfig } from "@/types";
import { basenameNoExt } from "@/utils/notePath";

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

/** Collapsible section matching Obsidian's graph-control-section pattern. */
function ControlSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  const iconRef = React.useCallback(
    (el: HTMLDivElement | null) => {
      if (el) {
        el.empty();
        setIcon(el, "right-triangle");
      }
    },
    [],
  );

  return (
    <div className="graph-control-section">
      <div
        className="tree-item-self is-clickable"
        onClick={() => setOpen((o) => !o)}
      >
        <div
          ref={iconRef}
          className={`tree-item-icon collapse-icon${open ? "" : " is-collapsed"}`}
        />
        <div className="tree-item-inner">
          <header className="graph-control-section-header">{title}</header>
        </div>
      </div>
      {open && <div className="tree-item-children">{children}</div>}
    </div>
  );
}

/** Stepper control: [−] value [+] for small discrete ranges. */
function Stepper({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="hermes-agent-stepper">
      <button
        className="clickable-icon"
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        aria-label="Decrease"
      >
        <ObsidianIcon name="minus" />
      </button>
      <span className="hermes-agent-stepper-value">{value}</span>
      <button
        className="clickable-icon"
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        aria-label="Increase"
      >
        <ObsidianIcon name="plus" />
      </button>
    </div>
  );
}

/** Slider that shows a tooltip with the current value on hover, matching Obsidian's built-in graph controls. */
function SliderWithTooltip({
  value,
  min,
  max,
  step,
  formatValue,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  formatValue?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const [hovering, setHovering] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const display = formatValue ? formatValue(value) : String(value);
  // The range thumb center travels from thumbRadius to (trackWidth - thumbRadius),
  // not 0% to 100%. Compensate so the tooltip follows the thumb precisely.
  // Obsidian's range thumb is ~20px wide.
  const THUMB = 20; // px
  const pct = (value - min) / (max - min);

  const onPointerEnter = useCallback(() => setHovering(true), []);
  const onPointerLeave = useCallback(() => setHovering(false), []);

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", display: "flex", flex: "1" }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      {hovering && (
        <div
          className="tooltip"
          style={{
            position: "absolute",
            bottom: "100%",
            left: `calc(${THUMB / 2}px + ${pct} * (100% - ${THUMB}px))`,
            transform: "translateX(-50%)",
            marginBottom: 4,
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          {display}
        </div>
      )}
    </div>
  );
}

/** The filter sliders content, reused in both docked and undocked positions. */
function FilterSliders({
  settings,
  onSettingsChange,
}: {
  settings: GraphViewSettings;
  onSettingsChange: (partial: Partial<GraphViewSettings>) => void;
}) {
  return (
    <>
      {/* Link depth stepper */}
      <div className="setting-item">
        <div className="setting-item-info">
          <div className="setting-item-name">Depth</div>
        </div>
        <div className="setting-item-control hermes-agent-stepper-control">
          <Stepper
            min={1}
            max={3}
            value={settings.linkDepth}
            onChange={(v) => onSettingsChange({ linkDepth: v as 1 | 2 | 3 })}
          />
        </div>
      </div>

      {/* Similarity threshold slider (inverted: right = lower threshold = more edges) */}
      <div className="setting-item mod-slider">
        <div className="setting-item-info">
          <div className="setting-item-name">Similarity</div>
        </div>
        <div className="setting-item-control">
          <SliderWithTooltip
            min={0.3}
            max={0.8}
            step={0.05}
            value={1.1 - settings.similarityThreshold}
            formatValue={(v) => (1.1 - v).toFixed(2)}
            onChange={(v) => onSettingsChange({ similarityThreshold: 1.1 - v })}
          />
        </div>
      </div>
    </>
  );
}

/** Bare floating sliders overlay — transparent by default, opaque on hover. */
export function FilterHud({
  settings,
  onSettingsChange,
}: {
  settings: GraphViewSettings;
  onSettingsChange: (partial: Partial<GraphViewSettings>) => void;
}) {
  return (
    <div className="hermes-agent-graph-filter-hud">
      <FilterSliders settings={settings} onSettingsChange={onSettingsChange} />
    </div>
  );
}

export function GraphControls({ settings, onSettingsChange, onRefresh, isLoading }: GraphControlsProps) {
  const [open, setOpen] = useState(false);
  const filtersUndocked = settings.floatSliders;

  return (
    <>
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

        {/* ── Filters section ── */}
        <ControlSection title="Filters" defaultOpen>
          {!filtersUndocked && (
            <FilterSliders settings={settings} onSettingsChange={onSettingsChange} />
          )}

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

          {/* Undock sliders to floating HUD */}
          <div className="setting-item mod-toggle">
            <div className="setting-item-info">
              <div className="setting-item-name">Float sliders</div>
            </div>
            <div className="setting-item-control">
              <div
                className={`checkbox-container${filtersUndocked ? " is-enabled" : ""}`}
                onClick={() => onSettingsChange({ floatSliders: !filtersUndocked })}
              />
            </div>
          </div>
        </ControlSection>

        {/* ── Forces section ── */}
        <ControlSection title="Forces">
          {/* Center force */}
          <div className="setting-item mod-slider">
            <div className="setting-item-info">
              <div className="setting-item-name">Center force</div>
            </div>
            <div className="setting-item-control">
              <SliderWithTooltip
                min={0}
                max={100}
                step={1}
                value={Math.round(settings.centerForce * 100)}
                formatValue={(v) => `${v}%`}
                onChange={(v) => onSettingsChange({ centerForce: v / 100 })}
              />
            </div>
          </div>

          {/* Repel force */}
          <div className="setting-item mod-slider">
            <div className="setting-item-info">
              <div className="setting-item-name">Repel force</div>
            </div>
            <div className="setting-item-control">
              <SliderWithTooltip
                min={0}
                max={500}
                step={10}
                value={settings.repelForce}
                onChange={(v) => onSettingsChange({ repelForce: v })}
              />
            </div>
          </div>

          {/* Link distance */}
          <div className="setting-item mod-slider">
            <div className="setting-item-info">
              <div className="setting-item-name">Link distance</div>
            </div>
            <div className="setting-item-control">
              <SliderWithTooltip
                min={50}
                max={500}
                step={10}
                value={settings.linkDistance}
                onChange={(v) => onSettingsChange({ linkDistance: v })}
              />
            </div>
          </div>
        </ControlSection>

        {/* ── Pinned section ── */}
        <ControlSection title="Pinned">
          {(settings.pinnedNodes ?? []).length === 0 ? (
            <div className="setting-item">
              <div className="setting-item-info">
                <div className="setting-item-name hermes-agent-pinned-hint">
                  Right-click a node to pin it
                </div>
              </div>
            </div>
          ) : (
            <>
              {(settings.pinnedNodes ?? []).map((pin) => {
                const title = basenameNoExt(pin.path);
                const overrides: string[] = [];
                if (pin.linkDepth != null) overrides.push(`d:${pin.linkDepth}`);
                if (pin.similarityThreshold != null) overrides.push(`s:${pin.similarityThreshold.toFixed(2)}`);
                return (
                  <div key={pin.path} className="setting-item hermes-agent-pinned-item">
                    <div className="setting-item-info">
                      <div className="setting-item-name hermes-agent-pinned-name" title={pin.path}>
                        {title}
                        {overrides.length > 0 && (
                          <span className="hermes-agent-pinned-overrides"> {overrides.join(" ")}</span>
                        )}
                      </div>
                    </div>
                    <div className="setting-item-control">
                      <button
                        className="clickable-icon"
                        aria-label={`Unpin ${title}`}
                        onClick={() => {
                          const pinnedNodes = (settings.pinnedNodes ?? []).filter((p) => p.path !== pin.path);
                          onSettingsChange({ pinnedNodes });
                        }}
                      >
                        <ObsidianIcon name="x" />
                      </button>
                    </div>
                  </div>
                );
              })}
              <div className="setting-item">
                <div className="setting-item-info" />
                <div className="setting-item-control">
                  <button
                    className="clickable-icon hermes-agent-pinned-clear"
                    aria-label="Clear all pins"
                    onClick={() => onSettingsChange({ pinnedNodes: [] })}
                  >
                    Clear all
                  </button>
                </div>
              </div>
            </>
          )}
        </ControlSection>
      </div>

      {/* Floating filter sliders when undocked */}
      {filtersUndocked && (
        <FilterHud
          settings={settings}
          onSettingsChange={onSettingsChange}
        />
      )}
    </>
  );
}
