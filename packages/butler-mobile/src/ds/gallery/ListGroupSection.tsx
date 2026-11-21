import { useState } from "react";
import { View } from "react-native";
import { useTokens } from "../../design/useTokens";
import { Button } from "../Button";
import { icons } from "../icons";
import { ListGroup, ListGroupItem } from "../ListGroup";
import { ListRow } from "../ListRow";
import { Switch } from "../Switch";
import { en } from "./fixtures";

const noop = () => {};

export function ListGroupSection() {
  const t = useTokens();
  const [on, setOn] = useState(true);
  return (
    <View style={{ paddingHorizontal: t.length("--adaptive-page-gutter"), gap: t.length("--space-4") }}>
      <ListGroup label="Preferences" footer={en.note} testID="ds-list-group-labelled">
        <ListRow icon={icons.Lock} title="Security" navigates onPress={noop} />
        <ListRow icon={icons.SlidersHorizontal} title="Theme" meta="Auto" onPress={noop} />
        <ListRow icon={icons.Palette} title="Show thinking" description={en.note}
          trailing={<Switch value={on} label="Show thinking" onValueChange={setOn} />} />
      </ListGroup>
      <ListGroup testID="ds-list-group-plain">
        <ListRow title={en.sentence} meta={en.meta} />
        <ListRow title={en.sentence} description={en.note} />
        <ListGroupItem><Button label={en.action} variant="secondary" onPress={noop} /></ListGroupItem>
      </ListGroup>
      <ListGroup testID="ds-list-group-destructive">
        <ListRow icon={icons.Unlink} title="Disconnect" destructive onPress={noop} />
      </ListGroup>
    </View>
  );
}
