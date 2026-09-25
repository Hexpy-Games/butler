import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { Button } from "../Button";
import { Plus, Search } from "../Icons";
import { Stack } from "../Stack";
import { ButtonContainer } from "./ButtonContainer";
import styles from "./ButtonContainer.module.css";

export const meta: ShowcaseMeta = {
  title: "ButtonContainer",
  category: "Action",
  tags: ["action", "buttons", "spacing"],
  status: "stable",
};

const copy = {
  "en-US": { import: "Import", create: "Create by chatting", search: "Search", new: "Create", cancel: "Cancel", save: "Save" },
  "ko-KR": { import: "가져오기", create: "대화해서 만들기", search: "검색", new: "만들기", cancel: "취소", save: "저장" },
} as const;

export const stories: ShowcaseStory[] = [
  {
    name: "Small",
    render: ({ locale }) => (
      <ButtonContainer size="sm">
        <Button size="sm" variant="outline" text={copy[locale].import} />
        <Button size="sm" iconStart={<Plus size="sm" />} text={copy[locale].create} />
      </ButtonContainer>
    ),
  },
  {
    name: "Default",
    render: ({ locale }) => (
      <Stack className={styles.fixture} gap="md">
        <ButtonContainer size="default">
          <Button iconStart={<Search size="md" />} text={copy[locale].search} />
          <Button iconStart={<Plus size="md" />} text={copy[locale].new} />
        </ButtonContainer>
        <ButtonContainer size="default">
          <Button variant="outline" text={copy[locale].cancel} />
          <Button text={copy[locale].save} />
        </ButtonContainer>
      </Stack>
    ),
  },
];
