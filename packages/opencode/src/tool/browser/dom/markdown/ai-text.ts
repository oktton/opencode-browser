/**
 * AI-Optimized Text Conversion for EnhancedDOMTreeNode
 *
 * Converts DOM nodes to AI-friendly text representations.
 * Adapted from the legacy convertNodeToAiText.ts to work with EnhancedDOMTreeNode.
 */

import type { EnhancedDOMTreeNode } from '../types/dom-node';
import { NAME_FROM_CONTENT_ROLES } from '../types/ax';

export interface ConversionOptions {
  maxTextLength?: number;
}

export interface ConversionResult {
  text: string;
  hasContent: boolean;
}

interface HandlerContext {
  text: string;
  attrs: Record<string, string>;
  maxTextLength: number;
  tagName: string;
  inputType?: string;
  role?: string;
}

interface TruncateResult {
  text: string;
  truncated: boolean;
  originalLength: number;
}

type ElementHandler = (
  node: EnhancedDOMTreeNode,
  context: HandlerContext,
) => ConversionResult;

/**
 * Extract direct text content from a node.
 * Combines two sources: axNode.name and immediate StaticText children's axNode.name.
 */
export function getDirectTextContent(node: EnhancedDOMTreeNode): string {
  const texts: string[] = [];

  if (
    node.axNode?.name &&
    node.axNode.role &&
    NAME_FROM_CONTENT_ROLES.has(node.axNode.role)
  ) {
    texts.push(node.axNode.name.trim());
  }

  for (const child of node.childrenNodes ?? []) {
    if (child.axNode?.role === 'StaticText' && child.axNode?.name) {
      texts.push(child.axNode.name.trim());
    }
  }

  return texts.filter(Boolean).join(' ').replace(/\s+/g, ' ');
}

function truncateText(
  text: string,
  maxLength: number,
  showIndicator: boolean = true,
): TruncateResult {
  if (text.length <= maxLength) {
    return { text, truncated: false, originalLength: text.length };
  }

  const truncated = text.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  const cutPoint = lastSpace > maxLength * 0.7 ? lastSpace : maxLength;

  return {
    text: truncated.substring(0, cutPoint) + (showIndicator ? '...' : ''),
    truncated: true,
    originalLength: text.length,
  };
}

// Tag-specific state flag definitions
const GLOBAL_STATE_FLAGS = ['disabled'];

const TAG_STATE_FLAGS: Record<string, string[]> = {
  button: ['aria-pressed'],
  select: ['aria-expanded'],
  details: [],
  video: [],
  audio: [],
  progress: [],
  meter: [],
};

const INPUT_TYPE_STATE_FLAGS: Record<string, string[]> = {
  text: ['readonly', 'required', 'aria-invalid'],
  search: ['readonly', 'required', 'aria-invalid'],
  email: ['readonly', 'required', 'aria-invalid'],
  password: ['readonly', 'required', 'aria-invalid'],
  tel: ['readonly', 'required', 'aria-invalid'],
  url: ['readonly', 'required', 'aria-invalid'],
  number: ['readonly', 'required', 'aria-invalid'],
  checkbox: ['aria-checked'],
  radio: ['required'],
  range: [],
  file: ['required'],
  date: ['readonly', 'required'],
  time: ['readonly', 'required'],
  'datetime-local': ['readonly', 'required'],
  month: ['readonly', 'required'],
  week: ['readonly', 'required'],
  color: [],
  submit: [],
  button: [],
};

const TEXTAREA_STATE_FLAGS = ['readonly', 'required', 'aria-invalid'];

function getStateFlags(
  attrs: Record<string, string>,
  tagName: string,
  inputType?: string,
): string[] {
  const flags: string[] = [];

  for (const attr of GLOBAL_STATE_FLAGS) {
    if (attrs[attr] !== undefined) flags.push(attr);
  }

  let tagFlags: string[] | undefined;
  if (tagName === 'input') {
    tagFlags = INPUT_TYPE_STATE_FLAGS[inputType || 'text'];
  } else if (tagName === 'textarea') {
    tagFlags = TEXTAREA_STATE_FLAGS;
  } else {
    tagFlags = TAG_STATE_FLAGS[tagName];
  }

  if (tagFlags) {
    for (const attr of tagFlags) {
      if (attr === 'aria-checked') {
        if (
          attrs['aria-checked'] &&
          attrs['aria-checked'] !== (attrs.checked || 'false')
        ) {
          flags.push(`aria-checked=${attrs['aria-checked']}`);
        }
      } else if (attr === 'aria-pressed') {
        if (attrs['aria-pressed'])
          flags.push(`pressed=${attrs['aria-pressed']}`);
      } else if (attr === 'aria-expanded') {
        if (attrs['aria-expanded'])
          flags.push(`expanded=${attrs['aria-expanded']}`);
      } else if (attr === 'aria-invalid') {
        if (attrs['aria-invalid'] === 'true') flags.push('invalid');
      } else if (attrs[attr] !== undefined) {
        flags.push(attr);
      }
    }
  }

  return flags;
}

// Tag-specific context info definitions (attributes that provide labeling/description)
const GLOBAL_CONTEXT_ATTRS = ['title', 'aria-label'];

const TAG_CONTEXT_ATTRS: Record<string, string[]> = {
  button: ['aria-describedby'],
  a: [],
  img: [],
  select: ['name', 'aria-describedby', 'aria-controls'],
  details: [],
  video: [],
  audio: [],
  progress: [],
  meter: [],
};

const INPUT_TYPE_CONTEXT_ATTRS: Record<string, string[]> = {
  text: ['name', 'placeholder', 'aria-describedby'],
  search: ['name', 'placeholder', 'aria-describedby'],
  email: ['name', 'placeholder', 'aria-describedby'],
  password: ['name', 'placeholder', 'aria-describedby'],
  tel: ['name', 'placeholder', 'aria-describedby'],
  url: ['name', 'placeholder', 'aria-describedby'],
  number: ['name', 'placeholder', 'aria-describedby'],
  checkbox: ['name'],
  radio: ['name'],
  range: [],
  file: ['name'],
  date: ['name', 'aria-describedby'],
  time: ['name', 'aria-describedby'],
  'datetime-local': ['name', 'aria-describedby'],
  month: ['name', 'aria-describedby'],
  week: ['name', 'aria-describedby'],
  color: ['name'],
  submit: [],
  button: [],
};

const TEXTAREA_CONTEXT_ATTRS = ['name', 'placeholder', 'aria-describedby'];

// ARIA role-specific context attrs
const ROLE_CONTEXT_ATTRS: Record<string, string[]> = {
  combobox: ['aria-describedby', 'aria-controls'],
  tab: ['aria-controls'],
  spinbutton: ['aria-describedby'],
  slider: [],
  switch: ['aria-describedby'],
};

function getContextInfo(
  text: string,
  attrs: Record<string, string>,
  tagName: string,
  inputType?: string,
  role?: string,
): string[] {
  const context: string[] = [];

  const formatMap: Record<string, string> = {
    title: 'title',
    'aria-label': 'aria',
    placeholder: 'placeholder',
    'aria-describedby': 'described-by',
    'aria-controls': 'controls',
    name: 'name',
  };

  const addAttr = (attr: string) => {
    if (attrs[attr]) {
      context.push(`${formatMap[attr] || attr}: ${attrs[attr]}`);
    }
  };

  for (const attr of GLOBAL_CONTEXT_ATTRS) {
    addAttr(attr);
  }

  // Role-specific attrs take priority
  if (role && ROLE_CONTEXT_ATTRS[role]) {
    for (const attr of ROLE_CONTEXT_ATTRS[role]) {
      addAttr(attr);
    }
  }

  let tagAttrs: string[] | undefined;
  if (tagName === 'input') {
    tagAttrs = INPUT_TYPE_CONTEXT_ATTRS[inputType || 'text'];
  } else if (tagName === 'textarea') {
    tagAttrs = TEXTAREA_CONTEXT_ATTRS;
  } else {
    tagAttrs = TAG_CONTEXT_ATTRS[tagName];
  }

  if (tagAttrs) {
    for (const attr of tagAttrs) {
      // Avoid duplicates from role-specific attrs
      if (!context.some(c => c.startsWith(`${formatMap[attr] || attr}:`))) {
        addAttr(attr);
      }
    }
  }

  // Filter out context entries redundant with text (mutual includes)
  if (text) {
    const normalizedText = text.toLowerCase();
    return context.filter(entry => {
      const value = entry.substring(entry.indexOf(':') + 2).toLowerCase();
      return !normalizedText.includes(value) && !value.includes(normalizedText);
    });
  }

  return context;
}

function getLabelText(text: string, attrs: Record<string, string>): string {
  return (
    text ||
    attrs['aria-label'] ||
    attrs.title ||
    attrs.placeholder ||
    attrs.name ||
    ''
  );
}

// ============================================================================
// Element Handlers
// ============================================================================

function handleButton(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { text, attrs } = ctx;
  const type = attrs.type || 'button';
  const flags = getStateFlags(attrs, ctx.tagName, ctx.inputType);
  const context = getContextInfo(
    ctx.text,
    attrs,
    ctx.tagName,
    ctx.inputType,
    ctx.role,
  );

  const parts: string[] = [];

  if (type !== 'button') {
    parts.push(`BUTTON[${type}]`);
  } else {
    parts.push('BUTTON');
  }

  const hasContent = !!(text || flags.length > 0 || context.length > 0);

  if (text) {
    parts.push(': ' + text);
  }

  if (flags.length > 0) {
    parts.push(' [' + flags.join(', ') + ']');
  }

  if (context.length > 0) {
    parts.push(' (' + context.join('; ') + ')');
  }

  return { text: parts.join(''), hasContent };
}

function handleLink(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { text, attrs } = ctx;
  const label = text || attrs['aria-label'] || attrs.title || attrs.id;

  if (!label) {
    return { text: 'LINK', hasContent: false };
  }

  return { text: `LINK: ${label}`, hasContent: true };
}

function handleImage(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { attrs } = ctx;
  const alt = attrs.alt || attrs.title || 'Image';
  return { text: `IMAGE: ${alt}`, hasContent: true };
}

function handleHeading(
  node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { text } = ctx;
  const tagName = node.nodeName.toLowerCase();
  const level = parseInt(tagName.charAt(1));
  const hashes = '#'.repeat(Math.min(level, 6));

  if (!text) return { text: `${tagName}`, hasContent: false };
  return { text: `${hashes} ${text}`, hasContent: true };
}

function handleInputText(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { attrs } = ctx;
  const type = attrs.type || 'text';
  const value = attrs.value || '';
  const flags = getStateFlags(attrs, ctx.tagName, ctx.inputType);
  const context = getContextInfo(
    ctx.text,
    attrs,
    ctx.tagName,
    ctx.inputType,
    ctx.role,
  );
  const label = getLabelText(ctx.text, attrs);

  const parts: string[] = [];
  parts.push(`INPUT[${type}]`);

  if (label) {
    parts.push(`: ${label}`);
  }

  if (value) {
    const { text: truncatedValue, truncated } = truncateText(value, 50, true);
    parts.push(` | ${truncatedValue}`);
    if (truncated) flags.push('truncated');
  } else {
    parts.push(' | empty');
  }

  if (flags.length > 0) {
    parts.push(' [' + flags.join(', ') + ']');
  }

  if (context.length > 0) {
    parts.push(' (' + context.join('; ') + ')');
  }

  return { text: parts.join(''), hasContent: true };
}

function handleInputPassword(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { attrs } = ctx;
  const value = attrs.value || '';
  const flags = getStateFlags(attrs, ctx.tagName, ctx.inputType);
  const context = getContextInfo(
    ctx.text,
    attrs,
    ctx.tagName,
    ctx.inputType,
    ctx.role,
  );
  const label = getLabelText(ctx.text, attrs);

  const parts: string[] = [];
  parts.push('INPUT[password]');

  if (label) {
    parts.push(`: ${label}`);
  }

  if (value) {
    parts.push(` | ${'*'.repeat(Math.min(value.length, 8))}`);
  } else {
    parts.push(' | empty');
  }

  if (flags.length > 0) {
    parts.push(' [' + flags.join(', ') + ']');
  }

  if (context.length > 0) {
    parts.push(' (' + context.join('; ') + ')');
  }

  return { text: parts.join(''), hasContent: true };
}

function handleInputNumber(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { attrs } = ctx;
  const value = attrs.value || '';
  const min = attrs.min;
  const max = attrs.max;
  const step = attrs.step;
  const flags = getStateFlags(attrs, ctx.tagName, ctx.inputType);
  const label = getLabelText(ctx.text, attrs);

  const parts: string[] = [];
  parts.push('INPUT[number]');

  if (label) {
    parts.push(`: ${label}`);
  }

  if (value) {
    parts.push(` | ${value}`);
  } else {
    parts.push(' | empty');
  }

  const constraints: string[] = [];
  if (min !== undefined) constraints.push(`min=${min}`);
  if (max !== undefined) constraints.push(`max=${max}`);
  if (step !== undefined) constraints.push(`step=${step}`);

  if (flags.length > 0) {
    parts.push(' [' + flags.join(', ') + ']');
  }

  if (constraints.length > 0) {
    parts.push(' (' + constraints.join(', ') + ')');
  }

  return { text: parts.join(''), hasContent: true };
}

function handleInputCheckbox(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { attrs } = ctx;
  const checked =
    attrs.checked === 'true' ||
    attrs.checked === '' ||
    attrs.checked === 'checked';
  const ariaChecked = attrs['aria-checked'];
  const flags = getStateFlags(attrs, ctx.tagName, ctx.inputType);
  const label = getLabelText(ctx.text, attrs);

  let state = 'unchecked';
  if (ariaChecked === 'mixed') {
    state = 'indeterminate';
  } else if (checked || ariaChecked === 'true') {
    state = 'checked';
  }

  let result = `CHECKBOX: ${label} = ${state}`;

  if (flags.length > 0) {
    result += ` [${flags.join(', ')}]`;
  }

  return { text: result, hasContent: true };
}

function handleInputRadio(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { attrs } = ctx;
  const checked =
    attrs.checked === 'true' ||
    attrs.checked === '' ||
    attrs.checked === 'checked';
  const flags = getStateFlags(attrs, ctx.tagName, ctx.inputType);
  const label = getLabelText(ctx.text, attrs);
  const name = attrs.name;

  const parts: string[] = [];
  parts.push('RADIO');

  if (label) {
    parts.push(`: ${label}`);
  }

  if (name) {
    parts.push(` (name=${name})`);
  }

  parts.push(` = ${checked ? 'checked' : 'unchecked'}`);

  if (flags.length > 0) {
    parts.push(' [' + flags.join(', ') + ']');
  }

  return { text: parts.join(''), hasContent: true };
}

function handleInputRange(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { attrs } = ctx;
  const value = attrs.value || attrs.min || '0';
  const min = attrs.min || '0';
  const max = attrs.max || '100';
  const step = attrs.step;
  const label = getLabelText(ctx.text, attrs);

  const parts: string[] = [];
  parts.push('SLIDER');

  if (label) {
    parts.push(`: ${label}`);
  }

  parts.push(` = ${value} (min=${min}, max=${max}`);
  if (step) {
    parts[parts.length - 1] += `, step=${step}`;
  }
  parts[parts.length - 1] += ')';

  return { text: parts.join(''), hasContent: true };
}

function handleInputFile(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { attrs } = ctx;
  const value = attrs.value;
  const accept = attrs.accept;
  const multiple = attrs.multiple !== undefined;
  const label = getLabelText(ctx.text, attrs);

  const parts: string[] = [];
  parts.push('INPUT[file]');

  if (label) {
    parts.push(`: ${label}`);
  }

  if (value) {
    const fileName = value.split(/[/\\]/).pop() || value;
    if (multiple) {
      parts.push(' | selected: multiple files');
    } else {
      parts.push(` | selected: ${fileName}`);
    }
  } else {
    parts.push(' | no file');
  }

  if (accept) {
    parts.push(` (accept: ${accept})`);
  }

  return { text: parts.join(''), hasContent: true };
}

function handleInputDate(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { attrs } = ctx;
  const type = attrs.type || 'date';
  const value = attrs.value || '';
  const min = attrs.min;
  const max = attrs.max;
  const flags = getStateFlags(attrs, ctx.tagName, ctx.inputType);
  const label = getLabelText(ctx.text, attrs);

  const parts: string[] = [];
  parts.push(`INPUT[${type}]`);

  if (label) {
    parts.push(`: ${label}`);
  }

  if (value) {
    parts.push(` | ${value}`);
  } else {
    parts.push(' | empty');
  }

  const constraints: string[] = [];
  if (min) constraints.push(`min=${min}`);
  if (max) constraints.push(`max=${max}`);

  if (flags.length > 0) {
    parts.push(' [' + flags.join(', ') + ']');
  }

  if (constraints.length > 0) {
    parts.push(' (' + constraints.join(', ') + ')');
  }

  return { text: parts.join(''), hasContent: true };
}

function handleInputColor(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { attrs } = ctx;
  const value = attrs.value || '#000000';
  const label = getLabelText(ctx.text, attrs);

  const parts: string[] = [];
  parts.push('INPUT[color]');

  if (label) {
    parts.push(`: ${label}`);
  }

  parts.push(` | ${value}`);

  return { text: parts.join(''), hasContent: true };
}

function handleTextarea(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { attrs, maxTextLength } = ctx;
  const value = attrs.value || '';
  const rows = attrs.rows;
  const maxlength = attrs.maxlength;
  const flags = getStateFlags(attrs, ctx.tagName, ctx.inputType);
  const label = getLabelText(ctx.text, attrs);

  const parts: string[] = [];
  parts.push('TEXTAREA');

  if (label) {
    parts.push(`: ${label}`);
  }

  if (value) {
    const {
      text: truncatedValue,
      truncated,
      originalLength,
    } = truncateText(value, maxTextLength, true);
    parts.push(` | "${truncatedValue}"`);

    if (maxlength) {
      parts.push(` (${originalLength}/${maxlength} chars)`);
    } else if (truncated) {
      parts.push(` [truncated, ${originalLength} chars total]`);
    }
  } else {
    parts.push(' | empty');
    if (rows || maxlength) {
      const constraints: string[] = [];
      if (rows) constraints.push(`rows=${rows}`);
      if (maxlength) constraints.push(`max=${maxlength} chars`);
      parts.push(` (${constraints.join(', ')})`);
    }
  }

  if (flags.length > 0) {
    parts.push(' [' + flags.join(', ') + ']');
  }

  return { text: parts.join(''), hasContent: true };
}

function handleSelect(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { text, attrs } = ctx;
  const value = attrs.value || '(none)';
  const multiple = attrs.multiple !== undefined;
  const flags = getStateFlags(attrs, ctx.tagName, ctx.inputType);
  const label = getLabelText(text, attrs);

  const parts: string[] = [];

  if (multiple) {
    parts.push('SELECT[multiple]');
  } else {
    parts.push('SELECT');
  }

  if (label) {
    parts.push(`: ${label}`);
  }

  parts.push(` = ${value}`);

  if (flags.length > 0) {
    parts.push(' [' + flags.join(', ') + ']');
  }

  return { text: parts.join(''), hasContent: true };
}

function handleProgress(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { text, attrs } = ctx;
  const value = attrs.value;
  const max = attrs.max || '100';
  const label = getLabelText(text, attrs);

  const parts: string[] = [];
  parts.push('PROGRESS');

  if (label) {
    parts.push(`: ${label}`);
  }

  if (value !== undefined) {
    const percent = Math.round((parseFloat(value) / parseFloat(max)) * 100);
    parts.push(` = ${percent}% (value=${value}, max=${max})`);
  } else {
    parts.push(' = indeterminate');
  }

  return { text: parts.join(''), hasContent: true };
}

function handleMeter(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { text, attrs } = ctx;
  const value = parseFloat(attrs.value || '0');
  const min = parseFloat(attrs.min || '0');
  const max = parseFloat(attrs.max || '100');
  const low = parseFloat(attrs.low || min.toString());
  const high = parseFloat(attrs.high || max.toString());
  const optimum = parseFloat(attrs.optimum || ((min + max) / 2).toString());
  const label = getLabelText(text, attrs);

  let state = 'normal';
  if (optimum <= low) {
    state = value <= low ? 'optimal' : value >= high ? 'warning' : 'suboptimal';
  } else if (optimum >= high) {
    state = value >= high ? 'optimal' : value <= low ? 'warning' : 'suboptimal';
  } else {
    state = value >= low && value <= high ? 'optimal' : 'suboptimal';
  }

  const percent = Math.round(((value - min) / (max - min)) * 100);

  const parts: string[] = [];
  parts.push('METER');

  if (label) {
    parts.push(`: ${label}`);
  }

  parts.push(
    ` = ${percent}% [${state}] (min=${min}, low=${low}, high=${high}, max=${max})`,
  );

  return { text: parts.join(''), hasContent: true };
}

function handleDetails(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { text, attrs } = ctx;
  const open = attrs.open !== undefined;

  const parts: string[] = [];
  parts.push('DETAILS');

  if (text) {
    parts.push(`: ${text}`);
  }

  parts.push(open ? ' [open]' : ' [closed]');

  return { text: parts.join(''), hasContent: true };
}

function handleVideo(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { attrs } = ctx;
  const controls = attrs.controls !== undefined;
  const autoplay = attrs.autoplay !== undefined;
  const muted = attrs.muted !== undefined;
  const label = getLabelText(ctx.text, attrs);

  const parts: string[] = [];
  parts.push('VIDEO');

  if (label) {
    parts.push(`: ${label}`);
  }

  const states: string[] = [];
  if (controls) states.push('controls');
  if (autoplay) states.push('autoplay');
  if (muted) states.push('muted');

  if (states.length > 0) {
    parts.push(` [${states.join(', ')}]`);
  }

  return { text: parts.join(''), hasContent: true };
}

function handleAudio(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { attrs } = ctx;
  const controls = attrs.controls !== undefined;
  const autoplay = attrs.autoplay !== undefined;
  const muted = attrs.muted !== undefined;
  const label = getLabelText(ctx.text, attrs);

  const parts: string[] = [];
  parts.push('AUDIO');

  if (label) {
    parts.push(`: ${label}`);
  }

  const states: string[] = [];
  if (controls) states.push('controls');
  if (autoplay) states.push('autoplay');
  if (muted) states.push('muted');

  if (states.length > 0) {
    parts.push(` [${states.join(', ')}]`);
  }

  return { text: parts.join(''), hasContent: true };
}

function handleParagraph(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { text } = ctx;
  const tagName = _node.nodeName.toLowerCase();
  if (!text) return { text: `${tagName}`, hasContent: false };
  return { text, hasContent: true };
}

function handleSpan(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { text } = ctx;
  const tagName = _node.nodeName.toLowerCase();
  if (!text) return { text: `${tagName}`, hasContent: false };
  return { text, hasContent: true };
}

function handleAriaCombobox(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { text, attrs } = ctx;
  const expanded = attrs['aria-expanded'] === 'true';
  const value = attrs.value || text;
  const label = getLabelText(text, attrs);

  const parts: string[] = [];
  parts.push('COMBOBOX');

  if (label) {
    parts.push(`: ${label}`);
  }

  if (value) {
    parts.push(` | ${value}`);
  }

  parts.push(` [expanded=${expanded}]`);

  return { text: parts.join(''), hasContent: true };
}

function handleAriaSwitch(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { text, attrs } = ctx;
  const checked = attrs['aria-checked'] === 'true';
  const label = getLabelText(text, attrs);

  const parts: string[] = [];
  parts.push('SWITCH');

  if (label) {
    parts.push(`: ${label}`);
  }

  parts.push(` = ${checked ? 'on' : 'off'}`);

  return { text: parts.join(''), hasContent: true };
}

function handleAriaTab(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { text, attrs } = ctx;
  const selected = attrs['aria-selected'] === 'true';
  const controls = attrs['aria-controls'];
  const label = getLabelText(text, attrs);

  const parts: string[] = [];
  parts.push('TAB');

  if (label) {
    parts.push(`: ${label}`);
  }

  parts.push(` [selected=${selected}`);
  if (controls) {
    parts[parts.length - 1] += `, controls=${controls}`;
  }
  parts[parts.length - 1] += ']';

  return { text: parts.join(''), hasContent: true };
}

function handleAriaSpinbutton(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { text, attrs } = ctx;
  const value = attrs['aria-valuenow'] || attrs.value || '';
  const min = attrs['aria-valuemin'];
  const max = attrs['aria-valuemax'];
  const label = getLabelText(text, attrs);

  const parts: string[] = [];
  parts.push('SPINBUTTON');

  if (label) {
    parts.push(`: ${label}`);
  }

  if (value) {
    parts.push(` = ${value}`);
  }

  const constraints: string[] = [];
  if (min !== undefined) constraints.push(`min=${min}`);
  if (max !== undefined) constraints.push(`max=${max}`);

  if (constraints.length > 0) {
    parts.push(` (${constraints.join(', ')})`);
  }

  return { text: parts.join(''), hasContent: true };
}

function handleAriaSlider(
  _node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { text, attrs } = ctx;
  const value = attrs['aria-valuenow'] || attrs.value || '0';
  const min = attrs['aria-valuemin'] || '0';
  const max = attrs['aria-valuemax'] || '100';
  const label = getLabelText(text, attrs);

  const parts: string[] = [];
  parts.push('SLIDER');

  if (label) {
    parts.push(`: ${label}`);
  }

  parts.push(` = ${value} (min=${min}, max=${max})`);

  return { text: parts.join(''), hasContent: true };
}

function handleGenericElement(
  node: EnhancedDOMTreeNode,
  ctx: HandlerContext,
): ConversionResult {
  const { text } = ctx;
  const tagName = node.nodeName?.toUpperCase() || 'ELEMENT';

  if (text) {
    return { text: `${tagName}: ${text}`, hasContent: true };
  }

  return { text: `${tagName}`, hasContent: false };
}

// ============================================================================
// Handler Registry
// ============================================================================

const ROLE_HANDLERS = new Map<string, ElementHandler>([
  ['button', handleButton],
  ['combobox', handleAriaCombobox],
  ['switch', handleAriaSwitch],
  ['tab', handleAriaTab],
  ['spinbutton', handleAriaSpinbutton],
  ['slider', handleAriaSlider],
]);

const INPUT_TYPE_HANDLERS = new Map<string, ElementHandler>([
  ['text', handleInputText],
  ['email', handleInputText],
  ['password', handleInputPassword],
  ['search', handleInputText],
  ['tel', handleInputText],
  ['url', handleInputText],
  ['number', handleInputNumber],
  ['checkbox', handleInputCheckbox],
  ['radio', handleInputRadio],
  ['range', handleInputRange],
  ['file', handleInputFile],
  ['date', handleInputDate],
  ['time', handleInputDate],
  ['datetime-local', handleInputDate],
  ['month', handleInputDate],
  ['week', handleInputDate],
  ['color', handleInputColor],
  ['submit', handleButton],
  ['button', handleButton],
]);

const TAG_HANDLERS = new Map<string, ElementHandler>([
  ['button', handleButton],
  ['a', handleLink],
  ['img', handleImage],
  ['h1', handleHeading],
  ['h2', handleHeading],
  ['h3', handleHeading],
  ['h4', handleHeading],
  ['h5', handleHeading],
  ['h6', handleHeading],
  ['textarea', handleTextarea],
  ['select', handleSelect],
  ['progress', handleProgress],
  ['meter', handleMeter],
  ['details', handleDetails],
  ['video', handleVideo],
  ['audio', handleAudio],
  ['p', handleParagraph],
  ['span', handleSpan],
]);

function getElementHandler(
  tagName: string,
  role?: string,
  inputType?: string,
): ElementHandler {
  if (role && ROLE_HANDLERS.has(role)) {
    return ROLE_HANDLERS.get(role)!;
  }

  if (tagName === 'input' && inputType && INPUT_TYPE_HANDLERS.has(inputType)) {
    return INPUT_TYPE_HANDLERS.get(inputType)!;
  }

  if (TAG_HANDLERS.has(tagName)) {
    return TAG_HANDLERS.get(tagName)!;
  }

  return handleGenericElement;
}

/**
 * Convert an EnhancedDOMTreeNode to AI-optimized text representation
 */
export function convertNodeToAiText(
  node: EnhancedDOMTreeNode,
  options: ConversionOptions = {},
): ConversionResult {
  const { maxTextLength = 100 } = options;

  const tagName = node.nodeName.toLowerCase();
  const text = getDirectTextContent(node);
  const attrs = node.attributes || {};
  const role = attrs.role;
  const inputType = tagName === 'input' ? attrs.type : undefined;

  const context: HandlerContext = {
    text: text.trim(),
    attrs,
    maxTextLength,
    tagName,
    inputType,
    role,
  };

  const handler = getElementHandler(tagName, role, inputType);
  return handler(node, context);
}
