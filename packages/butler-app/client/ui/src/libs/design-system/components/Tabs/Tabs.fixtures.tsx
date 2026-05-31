import { Blocks, Command, FileText } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs";

export function TabsFixture() {
  return (
    <Tabs defaultValue="summary" data-ds-fixture="tabs">
      <TabsList aria-label="Inspector sections">
        <TabsTrigger value="summary"><Command size={15} />Summary</TabsTrigger>
        <TabsTrigger value="files"><FileText size={15} />Files</TabsTrigger>
        <TabsTrigger value="workers"><Blocks size={15} />Workers</TabsTrigger>
      </TabsList>
      <TabsContent value="summary">
        <Stack gap="1">
          <Typo.PanelSectionTitle>Summary</Typo.PanelSectionTitle>
          <Typo.Caption>Right-panel style tab surface.</Typo.Caption>
        </Stack>
      </TabsContent>
      <TabsContent value="files">
        <Typo.Caption>Changed files and artifacts.</Typo.Caption>
      </TabsContent>
      <TabsContent value="workers">
        <Typo.Caption>Worker activity and review state.</Typo.Caption>
      </TabsContent>
    </Tabs>
  );
}
