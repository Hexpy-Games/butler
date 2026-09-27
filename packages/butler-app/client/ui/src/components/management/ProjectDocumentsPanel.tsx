import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { useState } from "react";
import {
  groupSpecs,
  planBoardTabs,
  planLanes,
  planBoardType,
  planLane,
  projectDocumentBadgeLabel,
} from "@/app/projectDocuments.ts";
import {
  BookOpenText,
  DocumentTile,
  FileText,
  KanbanBoard,
  KanbanLane,
  ListChecks,
  NavRow,
  Section,
  SplitBrowser,
  Stack,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
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
  useAppLocale();
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
      <Section gap="lg" icon={<ListChecks size="md" />} title={appCopy.interfacePanels.plans}>
        {plans.length > 0 ? (
          <Tabs defaultValue="work">
            <TabsList variant="line">
              {planBoardTabs().map((tab) => (
                <TabsTrigger key={tab.id} value={tab.id}>
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {planBoardTabs().map((tab) => {
              const tabPlans = plans.filter((plan) => planBoardType(plan) === tab.id);
              return (
                <TabsContent key={tab.id} value={tab.id}>
                  <KanbanBoard data-test-class={`project-plan-kanban-${tab.id}`}>
                    {planLanes().map((lane) => {
                      const lanePlans = tabPlans.filter((plan) => planLane(plan) === lane.id);
                      return (
                        <KanbanLane key={lane.id} title={lane.label}>
                          {lanePlans.length > 0 ? (
                            lanePlans.map((document) => (
                              <DocumentTile
                                badge={projectDocumentBadgeLabel(document)}
                                icon={<FileText size="md" />}
                                key={document.id}
                                title={document.title}
                                meta={document.status ?? document.safe_path_label}
                                actionLabel={appCopy.common.open} onOpen={() => onSelectDocument(document)}
                              />
                            ))
                          ) : (
                            <EmptyPanelLine label={appCopy.interfaceTemplates.emptyLane(tab.label)} />
                          )}
                        </KanbanLane>
                      );
                    })}
                  </KanbanBoard>
                </TabsContent>
              );
            })}
          </Tabs>
        ) : (
          <EmptyPanelLine label={appCopy.interfacePanels.noPlans} />
        )}
      </Section>
      <Section gap="lg" icon={<BookOpenText size="md" />} title={appCopy.interfacePanels.specs}>
        {specsByCategory.length > 0 ? (
          <SplitBrowser
            data-test-class="project-spec-groups"
            nav={specsByCategory.map(([category, categorySpecs]) => (
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
          >
            {activeSpecs.map((document) => (
              <DocumentTile
                icon={<FileText size="md" />}
                key={document.id}
                title={document.title}
                meta={document.safe_path_label}
                actionLabel={appCopy.common.open} onOpen={() => onSelectDocument(document)}
              />
            ))}
          </SplitBrowser>
        ) : (
          <EmptyPanelLine label={appCopy.interfacePanels.noSpecs} />
        )}
      </Section>
    </Stack>
  );
}
