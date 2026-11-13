import { useState } from 'react';

/**
 * Text cut to about `limit` characters (at a word) with a "Read more" toggle;
 * shorter text shows as is.
 */
export const ExpandableText = ({ text, limit, className }: { text: string; limit: number; className?: string }) => {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > limit;
  let shown = text;
  if (long && !expanded) {
    const space = text.lastIndexOf(' ', limit);
    shown = `${text.slice(0, space > limit * 0.6 ? space : limit).trimEnd()}…`;
  }
  return (
    <p className={className}>
      {shown}
      {long && (
        <>
          {' '}
          <button type="button" onClick={() => setExpanded(!expanded)} className="font-medium text-primary hover:underline">
            {expanded ? 'Show less' : 'Read more'}
          </button>
        </>
      )}
    </p>
  );
};
