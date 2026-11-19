import React from 'react';

interface Props {
  className?: string;
}

export const DroidForgeMark: React.FC<Props> = ({ className = 'h-8 w-8' }) => {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      <rect x="1" y="1" width="30" height="30" fill="#C7F900" stroke="#111111" strokeWidth="2" />
      <rect x="8" y="8" width="16" height="19" fill="#FFFFFF" stroke="#111111" strokeWidth="2" />
      <line x1="11" y1="5" x2="13" y2="8" stroke="#111111" strokeWidth="2" strokeLinecap="square" />
      <line x1="21" y1="5" x2="19" y2="8" stroke="#111111" strokeWidth="2" strokeLinecap="square" />
      <line x1="12" y1="15" x2="20" y2="15" stroke="#111111" strokeWidth="2" />
      <line x1="16" y1="12" x2="16" y2="21" stroke="#111111" strokeWidth="2" />
      <rect x="12" y="23" width="8" height="2" fill="#111111" />
    </svg>
  );
};
