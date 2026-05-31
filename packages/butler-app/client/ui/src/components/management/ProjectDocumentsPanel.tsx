import { useState } from "react";
import {
  groupSpecs,
  PLAN_BOARD_TABS,
  PLAN_LANES,
  planBoardType,
  planLane,
  projectDocumentBadgeLabel,
  projectDocumentLayout,
} from "@/app/projectDocuments.ts";
import {
  BookOpenText,
  DocumentTile,
  FileText,
  Grid,
  ListChecks,
  NavRow,
  Section,
  ScrollArea,
  Stack,
  SurfacePanel,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Typo,
} from "@/butler-ds";
import { EmptyPanelLine } from "@/components/common/Display.tsx";
import type { ProjectDashboardDocument } from "@/app/types.ts";

export function ProjectDocumentsPanel({
  documents,
  onSelectDocument,
}: {
  documents: ProjectDashboardDocument[];
  onSelectDocument: (document: ProjectDashboardDocument) => void;
}) {
  const specs = documents.filter((document) => document.kind === "spec");
  const plans = documents.filter((document) => planBoardType(document));
  const specsByCategory = groupSpecs(specs);
  const [selectedSpecCategory, setSelectedSpecCategory] = useState<string | null>(null);
  const activeSpecCategory =
    specsByCategory.some(([category]) => category === selectedSpecCategory)
      ? selectedSpecCategory
      : specsByCategory[0]?.[0] ?? null;
  const activeSpecs = specsByCategory.find(([category]) => category === activeSpecCategory)?.[1] ?? [];

  return (
    <Stack gap="xl">
      <Section gap="lg" icon={<ListChecks size={16} />} title="Plans">
        {plans.length > 0 ? (
          <Tabs defaultValue="work">
            <TabsList variant="line">
              {PLAN_BOARD_TABS.map((tab) => (
                <TabsTrigger key={tab.id} value={tab.id}>
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {PLAN_BOARD_TABS.map((tab) => {
              const tabPlans = plans.filter((plan) => planBoardType(plan) === tab.id);
              return (
                <TabsContent key={tab.id} value={tab.id}>
                  <Grid
                    columns="4"
                    gap="md"
                    style={projectDocumentLayout.planBoard}
                    data-test-class={`project-plan-kanban-${tab.id}`}
                  >
                    {PLAN_LANES.map((lane) => {
                      const lanePlans = tabPlans.filter((plan) => planLane(plan) === lane.id);
                      return (
                        <SurfacePanel
                          elevation="none"
                          key={lane.id}
                          style={projectDocumentLayout.lane}
                        >
                          <Stack gap="sm" style={projectDocumentLayout.laneInner}>
                            <Typo.PanelSectionTitle>{lane.label}</Typo.PanelSectionTitle>
                            <ScrollArea style={projectDocumentLayout.laneScroller}>
                              <Stack gap="sm">
                                {lanePlans.length > 0 ? (
                                  lanePlans.map((document) => (
                                    <DocumentTile
                                      badge={projectDocumentBadgeLabel(document)}
                                      icon={<FileText size={16} />}
                                      key={document.id}
                                      title={document.title}
                                      meta={document.status ?? document.safe_path_label}
                                      onOpen={() => onSelectDocument(document)}
                                    />
                                  ))
                                ) : (
                                  <EmptyPanelLine label={`No ${tab.label.toLowerCase()} items`} />
                                )}
                              </Stack>
                            </ScrollArea>
                          </Stack>
                        </SurfacePanel>
                      );
                    })}
                  </Grid>
                </TabsContent>
              );
            })}
          </Tabs>
        ) : (
          <EmptyPanelLine label="No Project Ledger plans found" />
        )}
      </Section>
      <Section gap="lg" icon={<BookOpenText size={16} />} title="Specs">
        {specsByCategory.length > 0 ? (
          <SurfacePanel
            elevation="none"
            style={projectDocumentLayout.specBrowserPanel}
            data-test-class="project-spec-groups"
          >
            <div style={projectDocumentLayout.specCategoryPane}>
              <ScrollArea style={projectDocumentLayout.specScroller}>
                <Stack gap="xs">
                  {specsByCategory.map(([category, categorySpecs]) => (
                    <NavRow
                      active={category === activeSpecCategory}
                      ariaLabel={category}
                      badge={categorySpecs.length}
                      dataTestClass="project-spec-category"
                      key={category}
                      label={category}
                      onClick={() => setSelectedSpecCategory(category)}
                    />
                  ))}
                </Stack>
              </ScrollArea>
            </div>
            <div style={projectDocumentLayout.specDocumentPane}>
              <ScrollArea style={projectDocumentLayout.specScroller}>
                <Stack gap="sm">
                  {activeSpecs.map((document) => (
                    <DocumentTile
                      icon={<FileText size={16} />}
                      key={document.id}
                      title={document.title}
                      meta={document.safe_path_label}
                      onOpen={() => onSelectDocument(document)}
                    />
                  ))}
                </Stack>
              </ScrollArea>
            </div>
          </SurfacePanel>
        ) : (
          <EmptyPanelLine label="No Project Ledger specs found" />
        )}
      </Section>
    </Stack>
  );
}
