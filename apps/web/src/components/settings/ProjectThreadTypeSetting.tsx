import { useState } from "react";
import { useProjects } from "../../state/entities";
import { useProjectGroupUpdate } from "../../hooks/useProjectGroupUpdate";
import { ThreadTypeSelect } from "../ThreadTypeSelect";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow } from "./settingsLayout";

export function ProjectThreadTypeSetting() {
  const { scope } = useSettingsScope();
  const projects = useProjects();
  const { updateProjectGroup } = useProjectGroupUpdate();
  const [saving, setSaving] = useState(false);
  if (scope.kind !== "project" && scope.kind !== "checkout") return null;
  const types = scope.members.map(
    (member) =>
      projects.find(
        (project) => project.id === member.id && project.environmentId === member.environmentId,
      )?.defaultThreadType ?? "t3",
  );
  const value = types.every((type) => type === types[0]) ? (types[0] ?? "t3") : null;
  return (
    <SettingsRow
      id="default-thread-type"
      title="Conversation type"
      description="Default for new conversations. Existing conversations keep their type. New Codex shared conversations currently require connecting an existing Desktop conversation."
      control={
        <ThreadTypeSelect
          value={value}
          label="Default conversation type"
          disabled={saving}
          onChange={(defaultThreadType) => {
            setSaving(true);
            void updateProjectGroup(
              scope.members,
              { defaultThreadType },
              "Conversation default not saved",
            ).finally(() => setSaving(false));
          }}
        />
      }
    />
  );
}
