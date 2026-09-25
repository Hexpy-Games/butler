import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { queuedShowcaseCopy } from "./QueuedMessage.showcaseCopy";
import { SendFlightStory, TransitionStory } from "./QueuedMessageMotionStories";
import { EditingStory, SeveralStory, ShowcaseQueued } from "./QueuedMessageStories";

export const meta: ShowcaseMeta = {
  title: "QueuedMessage",
  category: "Conversation & Activity",
  tags: ["conversation", "queue", "pending", "follow-up", "motion"],
  status: "beta",
};

export const stories: ShowcaseStory[] = [
  {
    name: "Single",
    render: (context) => {
      const copy = queuedShowcaseCopy(context);
      return <ShowcaseQueued copy={copy} first status={copy.queued}>{copy.messages[0]}</ShowcaseQueued>;
    },
  },
  { name: "Several with positions", render: (context) => <SeveralStory context={context} /> },
  {
    name: "Long text",
    widths: ["320", "375", "app"],
    render: (context) => {
      const copy = queuedShowcaseCopy(context);
      return <ShowcaseQueued copy={copy} first status={copy.queued}>{copy.long}</ShowcaseQueued>;
    },
  },
  { name: "Editing", states: ["edit"], render: (context) => <EditingStory context={context} /> },
  { name: "Send now", states: ["sending", "delivered"], render: (context) => <TransitionStory context={context} sendNow /> },
  { name: "Delivery", states: ["delivered"], render: (context) => <TransitionStory context={context} sendNow={false} /> },
  {
    name: "Failed",
    states: ["error"],
    render: (context) => {
      const copy = queuedShowcaseCopy(context);
      return <ShowcaseQueued copy={copy} tone="failed" status={copy.failed}>{copy.messages[1]}</ShowcaseQueued>;
    },
  },
  {
    name: "Send flight",
    states: ["enter"],
    widths: ["375", "app", "wide"],
    render: (context) => <SendFlightStory context={context} />,
  },
];
