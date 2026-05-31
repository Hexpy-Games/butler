import { Button } from "../Button";
import { Plus, Search } from "../Icons";
import { Stack } from "../Stack";
import { ButtonContainer } from "./ButtonContainer";
import styles from "./ButtonContainer.module.css";

export function ButtonContainerFixture() {
  return (
    <Stack className={styles.fixture} gap="3">
      <ButtonContainer size="sm">
        <Button size="sm" variant="outline">
          가져오기
        </Button>
        <Button size="sm">
          <Plus size={14} /> 대화해서 만들기
        </Button>
      </ButtonContainer>
      <ButtonContainer size="default">
        <Button iconStart={<Search size={16} />} text="Search" />
        <Button iconStart={<Plus size={16} />} text="Create" />
      </ButtonContainer>
    </Stack>
  );
}
