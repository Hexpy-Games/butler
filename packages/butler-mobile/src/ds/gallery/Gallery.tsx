import { ScrollView, View } from "react-native";
import { useTokens } from "../../design/useTokens";
import { ListRow } from "../ListRow";
import { Surface } from "../Surface";
import { Text } from "../Text";
import { sections } from "./sections";

export interface GalleryProps {
  section?: string;
  state?: string;
  onSelect: (id: string) => void;
}

export function Gallery({ section, state, onSelect }: GalleryProps) {
  const t = useTokens();
  const gutter = t.length("--adaptive-page-gutter");
  const current = sections.find((entry) => entry.id === section);
  return (
    <Surface variant="base" grow edges={["top", "bottom"]}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingVertical: gutter, gap: t.length("--space-xl") }}>
        <View style={{ paddingHorizontal: gutter }}>
          <Text variant={current ? "h4" : "appTitle"}>{current ? current.title : "Design system"}</Text>
        </View>
        {current ? (
          current.render(state)
        ) : (
          <View style={{ paddingHorizontal: t.length("--space-sm") }}>
            {sections.map((entry) => (
              <ListRow key={entry.id} title={entry.title} onPress={() => onSelect(entry.id)} testID={`ds-${entry.id}`} />
            ))}
          </View>
        )}
      </ScrollView>
    </Surface>
  );
}
