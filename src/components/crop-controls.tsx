"use client";

/**
 * crop-controls.tsx — apply / reset the brushed crop selection.
 *
 * Crop mode turns lane drags into a crop-band brush; the released selection is
 * stored as ui.cropSel in INDEX space. This surface shows the selected window
 * and commits it: Apply calls store.cropToSelection(startIdx, endIdx), which
 * trims the FULL-resolution Channel.values (and calls the EI /crop proxy for an
 * Edge Impulse sample). Reset clears the selection without cropping.
 *
 * Rendered only while crop mode is active (see lane-board.tsx).
 */

import * as React from "react";
import { Check, Scissors, X } from "lucide-react";
import { useEditorStore } from "@/lib/store";
import { Button } from "@/components/ui/Button";

export function CropControls() {
  const cropSel = useEditorStore((s) => s.ui.cropSel);
  const busy = useEditorStore((s) => s.ui.busy);
  const cropToSelection = useEditorStore((s) => s.cropToSelection);
  const setCropSel = useEditorStore((s) => s.setCropSel);

  const hasSel = !!cropSel && cropSel.endIdx > cropSel.startIdx;
  const count = hasSel ? cropSel!.endIdx - cropSel!.startIdx + 1 : 0;

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border bg-surface-2/60 px-3 py-2">
      <span className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
        <Scissors className="h-3.5 w-3.5" aria-hidden />
        Crop
      </span>
      {hasSel ? (
        <span className="text-xs text-fg">
          samples{" "}
          <span className="font-mono font-medium">{cropSel!.startIdx}</span>–
          <span className="font-mono font-medium">{cropSel!.endIdx}</span>{" "}
          <span className="text-fg-muted">({count} samples)</span>
        </span>
      ) : (
        <span className="text-xs text-fg-muted">
          Drag across a lane to select a time range to keep.
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setCropSel(null)}
          disabled={!hasSel || busy === "saving"}
          title="Clear the crop selection"
        >
          <X className="h-4 w-4" aria-hidden />
          Reset
        </Button>
        <Button
          size="sm"
          onClick={() => {
            if (hasSel) void cropToSelection(cropSel!.startIdx, cropSel!.endIdx);
          }}
          disabled={!hasSel || busy === "saving"}
          title="Trim the dataset to the selected range"
        >
          <Check className="h-4 w-4" aria-hidden />
          {busy === "saving" ? "Cropping…" : "Apply crop"}
        </Button>
      </div>
    </div>
  );
}
