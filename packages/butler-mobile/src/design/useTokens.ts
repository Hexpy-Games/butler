import { useColorScheme } from "react-native";
import { tokens, type Tokens } from "./tokens";

export function useTokens(): Tokens {
  return tokens(useColorScheme() === "dark" ? "dark" : "light");
}
