import type { ThreadType } from "@t3tools/contracts";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

export function ThreadTypeSelect({
  value,
  onChange,
  label = "Conversation type",
  disabled = false,
}: {
  value: ThreadType | null;
  onChange: (value: ThreadType) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === "t3" || next === "codex-shared") onChange(next);
      }}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue placeholder="Mixed">
          {value === "codex-shared" ? "Codex shared" : value === "t3" ? "T3 owned" : "Mixed"}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="t3">T3 owned</SelectItem>
        <SelectItem value="codex-shared">Codex shared</SelectItem>
      </SelectPopup>
    </Select>
  );
}
