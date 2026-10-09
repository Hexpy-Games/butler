// Viewer copy for the browser stories, as the App container passes it (butler-i18n `browser.*`).
export const BROWSER_DEMO_COPY = {
  "en-US": {
    browser: "Browser", conversation: "Office chair order", tabTitle: "Office chairs : Daily Goods", url: "https://shop.example.com/search?q=office-chair",
    back: "Back", forward: "Forward", reload: "Reload", pick: "Pick elements", scrap: "Scrap", bookmarks: "Bookmarks", more: "More",
    bringTab: "Bring in a tab", resizeChat: "Resize conversation", loading: "Loading page",
    agentUsing: "Butler is browsing", step: "Click ‘Mesh Office Chair M2’", takeOver: "Take over", stopTask: "Stop task",
    userControl: "You're in control", butlerWaits: "Butler is waiting", giveBack: "Give back to Butler",
    waiting: "Waiting for approval", payStep: "Pay ₩129,000", review: "Review",
    needYou: "Your input needed", keypad: "Security keypad · type it yourself",
    pickMode: "Picking", pickHint: "⇧ More · ⌥ Area", dragToChat: "drag into the chat", finish: "Done",
    popupBlocked: "Pop-up blocked", popupHost: "id.example.com", allow: "Allow", info: "Pop-up open", showPopup: "Show pop-up",
    picked: (count: number) => `${count} selected`, attach: "Add to chat", saveImage: "Save image", copyText: "Copy text", clear: "Clear",
    chat: ["Remember the chairs from last week? The ones with lumbar support.", "Yes, three mesh chairs with lumbar support, ₩120–190k.",
      "Order the cheapest one arriving tomorrow."],
    signedIn: "Signed in", output: "Butler output",
    peekEdge: "Peek the sidebar", nativePointer: "Pointer moves onto the native page", peekOpen: "Peek open", peekClosed: "Peek closed",
  },
  "ko-KR": {
    browser: "브라우저", conversation: "사무용 의자 주문", tabTitle: "사무용 의자 : 데일리굿즈", url: "https://shop.example.com/search?q=office-chair",
    back: "뒤로", forward: "앞으로", reload: "새로고침", pick: "요소 선택", scrap: "스크랩", bookmarks: "북마크", more: "더 보기",
    bringTab: "내 탭 가져오기", resizeChat: "대화 너비 조절", loading: "페이지 로딩 중",
    agentUsing: "버틀러가 조작 중", step: "‘메쉬 사무용 의자 M2’ 클릭", takeOver: "직접 조작", stopTask: "작업 중지",
    userControl: "직접 조작 중", butlerWaits: "버틀러가 기다리는 중", giveBack: "버틀러에게 돌려주기",
    waiting: "승인 대기", payStep: "129,000원 결제", review: "승인 보기",
    needYou: "직접 입력 필요", keypad: "보안 키패드 · 직접 입력해 주세요",
    pickMode: "요소 선택 중", pickHint: "⇧ 여러 개 · ⌥ 영역", dragToChat: "끌어서 대화에 놓기", finish: "끝내기",
    popupBlocked: "팝업 차단됨", popupHost: "id.example.com", allow: "허용", info: "팝업 열림", showPopup: "팝업 보기",
    picked: (count: number) => `${count}개 선택됨`, attach: "대화에 첨부", saveImage: "이미지로 저장", copyText: "텍스트 복사", clear: "선택 해제",
    chat: ["지난주에 보던 의자들 기억나? 허리 받침 있는 걸로.", "네, 요추 지지대가 있는 메쉬 의자 세 개를 보셨어요. 가격대는 12~19만원이었습니다.",
      "그중에 내일 도착하는 제일 싼 걸로 주문해줘."],
    signedIn: "로그인 사용", output: "버틀러 출력물",
    peekEdge: "사이드바 살짝 보기", nativePointer: "포인터가 네이티브 페이지로 이동", peekOpen: "열림", peekClosed: "닫힘",
  },
} as const;

export type BrowserDemoCopy = (typeof BROWSER_DEMO_COPY)[keyof typeof BROWSER_DEMO_COPY];
