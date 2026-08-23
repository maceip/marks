import type { ButtonHTMLAttributes, HTMLAttributes } from 'react';

type ChipProps =
  | ({ interactive?: false } & HTMLAttributes<HTMLSpanElement>)
  | ({ interactive: true } & ButtonHTMLAttributes<HTMLButtonElement>);

export function Chip(props: ChipProps) {
  if (props.interactive) {
    const { interactive: _, className = '', type = 'button', ...buttonProps } = props;
    return <button type={type} className={`ds-chip${className ? ` ${className}` : ''}`} {...buttonProps} />;
  }
  const { interactive: _, className = '', ...spanProps } = props;
  return <span className={`ds-chip${className ? ` ${className}` : ''}`} {...spanProps} />;
}
