/**
 * Attribute Whitelist Filter
 *
 * Filters element attributes using global + tag-specific whitelist strategy
 * to retain only semantically meaningful attributes for DOM serialization.
 */

const GLOBAL_WHITELIST = [
  'role',
  'aria-label',
  'aria-labelledby',
  'title',
  'disabled',
  'id',
];

const IMPORTANT_DATA_ATTRIBUTES = [
  'data-testid',
  'data-id',
  'data-value',
  'data-label',
  'data-name',
  'data-type',
  'data-action',
  'data-target',
  'data-is-selected',
];

const ARIA_ATTRIBUTES = [
  'aria-checked',
  'aria-selected',
  'aria-expanded',
  'aria-pressed',
  'aria-modal',
  'aria-valuemin',
  'aria-valuemax',
  'aria-valuenow',
  'aria-valuetext',
  'aria-required',
  'aria-readonly',
];

const TAG_SPECIFIC_WHITELIST: Record<string, string[]> = {
  button: ['type', 'aria-pressed'],
  a: [],
  i: ['class'],
  img: ['alt'],
  textarea: [
    'name',
    'value',
    'placeholder',
    'readonly',
    'required',
    'maxlength',
    'rows',
    'cols',
  ],
  select: ['name', 'value', 'multiple', 'aria-expanded'],
  option: ['value', 'selected', 'aria-selected'],
  label: ['for'],
  details: ['open'],
  dialog: ['open', 'aria-modal'],
  video: ['controls', 'autoplay', 'muted', 'loop'],
  audio: ['controls', 'autoplay', 'muted', 'loop'],
  iframe: ['title'],
  progress: ['value', 'max'],
  meter: ['value', 'min', 'max', 'low', 'high', 'optimum'],
  form: ['name'],
  th: ['scope', 'colspan', 'rowspan'],
  td: ['headers', 'colspan', 'rowspan'],
  colgroup: ['span'],
  col: ['span'],
};

const INPUT_TYPE_WHITELIST: Record<string, string[]> = {
  text: ['name', 'value', 'placeholder', 'readonly', 'required', 'maxlength'],
  search: ['name', 'value', 'placeholder', 'readonly', 'required'],
  email: ['name', 'value', 'placeholder', 'readonly', 'required'],
  password: ['name', 'placeholder', 'readonly', 'required'],
  tel: ['name', 'value', 'placeholder', 'readonly', 'required'],
  url: ['name', 'value', 'placeholder', 'readonly', 'required'],
  number: [
    'name',
    'value',
    'placeholder',
    'readonly',
    'required',
    'min',
    'max',
    'step',
  ],
  checkbox: ['name', 'value', 'checked', 'aria-checked'],
  radio: ['name', 'value', 'checked', 'aria-checked'],
  range: [
    'name',
    'value',
    'min',
    'max',
    'step',
    'aria-valuemin',
    'aria-valuemax',
    'aria-valuenow',
    'aria-valuetext',
  ],
  submit: ['type', 'value'],
  button: ['type', 'value'],
  file: ['name', 'accept', 'multiple'],
  date: ['name', 'value', 'min', 'max'],
  time: ['name', 'value', 'min', 'max'],
  'datetime-local': ['name', 'value', 'min', 'max'],
  color: ['name', 'value'],
  hidden: [],
};

/** Tags where global `id` is noise (auto-generated, not semantic) */
const SKIP_ID_TAGS = new Set(['svg', 'img']);

/**
 * Filter attributes using global + tag-specific whitelist strategy.
 */
export function getWhitelistedAttributes(
  nodeName: string,
  attributes: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  const tagName = nodeName.toLowerCase();
  const role = attributes.role;

  for (const attr of GLOBAL_WHITELIST) {
    if (attr === 'id' && SKIP_ID_TAGS.has(tagName)) continue;
    if (attributes[attr]?.trim()) result[attr] = attributes[attr];
  }

  for (const attr of IMPORTANT_DATA_ATTRIBUTES) {
    if (attributes[attr]?.trim()) result[attr] = attributes[attr];
  }

  if (role) {
    for (const attr of ARIA_ATTRIBUTES) {
      if (attributes[attr]?.trim()) result[attr] = attributes[attr];
    }
  }

  if (tagName === 'input') {
    const inputType = attributes.type || 'text';
    if (inputType === 'hidden') return {};
    if (inputType !== 'text') result['type'] = inputType;
    const typeWhitelist =
      INPUT_TYPE_WHITELIST[inputType] || INPUT_TYPE_WHITELIST['text'];
    for (const attr of typeWhitelist) {
      if (attributes[attr]?.trim()) result[attr] = attributes[attr];
    }
  } else if (TAG_SPECIFIC_WHITELIST[tagName]) {
    for (const attr of TAG_SPECIFIC_WHITELIST[tagName]) {
      if (attributes[attr]?.trim()) result[attr] = attributes[attr];
    }
  }

  if (tagName === 'button' || role === 'button') {
    if (attributes.type) result.type = attributes.type;
    if (attributes['aria-pressed'])
      result['aria-pressed'] = attributes['aria-pressed'];
  }

  if (role === 'slider') {
    for (const attr of [
      'value',
      'aria-valuemin',
      'aria-valuemax',
      'aria-valuenow',
      'aria-valuetext',
    ]) {
      if (attributes[attr]) result[attr] = attributes[attr];
    }
  }

  if (tagName === 'a' || role === 'link') {
    delete result.href;
  }

  return result;
}
