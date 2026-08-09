/**
 * Semantic predicates for the four-turn direct-conversation synthesis. The
 * final answer may be English or Korean; each predicate still requires its
 * complete claim so an omitted correction cannot pass by keyword overlap.
 */
export function directConversationClaimMatches(text: string): readonly boolean[] {
  return [
    hasAll(text, [
      /(?:reproducib|repeatable|재현|반복\s*가능)/iu,
      /(?:input|prompt|data|fixture|입력|프롬프트|데이터|픽스처)/iu,
      /(?:environment|configuration|config|setting|환경|설정)/iu,
      /(?:pin(?:s|ned|ning)?|fix(?:es|ed|ing)?|record(?:s|ed|ing)?|log(?:s|ged|ging)?|version(?:s|ed|ing)?|고정|기록|버전|로그)/iu,
    ]) || hasAll(text, [
      /(?:condition(?:s)?|조건)/iu,
      /(?:fix(?:ed|es|ing)?|hold(?:s|ing)?|held|identical|same|constant|고정|동일|유지)/iu,
      /(?:input|prompt|data|fixture|입력|프롬프트|데이터|픽스처)/iu,
      /(?:environment|configuration|config|setting|환경|설정)/iu,
    ]),
    hasAll(text, [
      /(?:confound(?:ing|er)?|교란\s*(?:변수|요인)?|혼란\s*(?:변수|요인)?|혼동\s*변수|혼입\s*변수)/iu,
      /(?:control(?:led|ling)?|isolat(?:e|ed|ing)|hold|constant|same|randomi[sz](?:e|ed|ing)?|통제|제어|고정|동일|무작위)/iu,
    ]),
    hasAll(text, [
      /(?:unavailable|not\s+available|missing|unsupported|unknown|사용할\s*수\s*없|사용\s*불가|사용\s*불가능|미지원|누락|측정\s*불가|측정할\s*수\s*없|측정\s*불가능|알\s*수\s*없|미확인)/iu,
      /(?:tool|measurement|metric|capability|도구|툴|측정|메트릭|기능)/iu,
    ]) && (/(?:gate(?:d)?|unknown|null|exclude|reject|게이트|차단|제외|알\s*수\s*없|미확인)/iu.test(text) || /(?:not|never|rather\s+than|instead\s+of)\b[^.]{0,80}\b(?:zero|0)\b/iu.test(text) || /(?:zero|0|영)\s*(?:이\s*아니|으로\s*(?:세지|처리하지|계산하지)|말고|않고)/iu.test(text)),
  ];
}

function hasAll(text: string, predicates: readonly RegExp[]): boolean {
  return predicates.every((predicate) => predicate.test(text));
}
