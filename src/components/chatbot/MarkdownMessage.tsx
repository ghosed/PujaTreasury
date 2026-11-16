import React from 'react';

function renderInlineFormatting(text: string): React.ReactNode[] {
  const tokens: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let keyIdx = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      tokens.push(
        <strong key={`b-${keyIdx++}`} className="font-semibold text-slate-900">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith('`') && token.endsWith('`')) {
      tokens.push(
        <code
          key={`c-${keyIdx++}`}
          className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[12px] text-slate-800"
        >
          {token.slice(1, -1)}
        </code>
      );
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    tokens.push(text.slice(lastIndex));
  }
  return tokens;
}

export const MarkdownMessage: React.FC<{ content: string }> = ({ content }) => {
  const lines = content.split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let listItems: string[] = [];
  let orderedListItems: string[] = [];

  const flushLists = (keyPrefix: number) => {
    if (listItems.length > 0) {
      blocks.push(
        <ul key={`ul-${keyPrefix}`} className="my-1.5 list-disc space-y-1 pl-5 text-sm text-slate-700">
          {listItems.map((item, idx) => (
            <li key={idx} className="leading-relaxed">
              {renderInlineFormatting(item)}
            </li>
          ))}
        </ul>
      );
      listItems = [];
    }
    if (orderedListItems.length > 0) {
      blocks.push(
        <ol key={`ol-${keyPrefix}`} className="my-1.5 list-decimal space-y-1 pl-5 text-sm text-slate-700">
          {orderedListItems.map((item, idx) => (
            <li key={idx} className="leading-relaxed">
              {renderInlineFormatting(item)}
            </li>
          ))}
        </ol>
      );
      orderedListItems = [];
    }
  };

  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line) {
      flushLists(idx);
      return;
    }

    if (line.startsWith('### ')) {
      flushLists(idx);
      blocks.push(
        <h4 key={`h3-${idx}`} className="mt-2.5 mb-1 text-xs font-semibold text-slate-900">
          {renderInlineFormatting(line.slice(4))}
        </h4>
      );
      return;
    }

    if (line.startsWith('## ') || line.startsWith('# ')) {
      flushLists(idx);
      const text = line.replace(/^#{1,2}\s+/, '');
      blocks.push(
        <h3 key={`h2-${idx}`} className="mt-2.5 mb-1 text-sm font-semibold text-slate-900">
          {renderInlineFormatting(text)}
        </h3>
      );
      return;
    }

    const bulletMatch = /^[-*]\s+(.*)$/.exec(line);
    if (bulletMatch) {
      if (orderedListItems.length > 0) flushLists(idx);
      listItems.push(bulletMatch[1]);
      return;
    }

    const numMatch = /^\d+\.\s+(.*)$/.exec(line);
    if (numMatch) {
      if (listItems.length > 0) flushLists(idx);
      orderedListItems.push(numMatch[1]);
      return;
    }

    flushLists(idx);
    blocks.push(
      <p key={`p-${idx}`} className="text-sm leading-relaxed text-slate-700">
        {renderInlineFormatting(line)}
      </p>
    );
  });

  flushLists(lines.length);

  return <div className="space-y-1.5">{blocks}</div>;
};
