import { useId, type CSSProperties, type SVGProps } from "react";
import { type ButlerMarkTheme, type ButlerMarkThemeColors, inkForButlerMarkTheme } from "./butlerMarkTheme.ts";

interface ButlerMarkIconProps extends Omit<SVGProps<SVGSVGElement>, "color"> {
  style?: CSSProperties;
  theme?: ButlerMarkTheme;
  themeColors?: ButlerMarkThemeColors;
  title?: string;
}

export function ButlerMarkIcon({
  theme = "dark",
  themeColors,
  title = "Butler",
  ...props
}: ButlerMarkIconProps) {
  const ink = inkForButlerMarkTheme(theme, themeColors);
  const generatedId = `butler-mark-${useId().replace(/:/gu, "-")}`;
  const titleId = title ? `${generatedId}-title` : undefined;
  const clipId = `${generatedId}-idle-clip`;

  return (
    <svg
      aria-hidden={title ? undefined : true}
      aria-labelledby={titleId}
      fill="none"
      role={title ? "img" : undefined}
      viewBox="0 0 1200 1200"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {title ? <title id={titleId}>{title}</title> : null}
      <defs>
        <clipPath id={clipId}>
          <circle cx="600" cy="600" r="406" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <path
          d="M300 464L600 600L900 464"
          stroke={ink}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="68"
        />
        <path
          d="M300 736L600 600L900 736"
          stroke={ink}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="68"
        />
        <path
          d="M300 464A329.43 329.43 0 0 0 300 736"
          stroke={ink}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="68"
        />
        <path
          d="M900 464A329.43 329.43 0 0 1 900 736"
          stroke={ink}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="68"
        />
      </g>
      <circle cx="600" cy="600" r="435" stroke={ink} strokeWidth="74" />
    </svg>
  );
}
