export namespace DOMSnapshot {
  export interface CaptureSnapshotParams {
    computedStyles: string[]
    includePaintOrder?: boolean
    includeDOMRects?: boolean
    includeBlendedBackgroundColors?: boolean
    includeTextColorOpacities?: boolean
  }

  export interface RareBooleanData {
    index: number[]
  }

  export interface NodeTreeSnapshot {
    parentIndex?: number[]
    nodeType?: number[]
    shadowRootType?: StringIndex[]
    nodeName?: StringIndex[]
    nodeValue?: StringIndex[]
    backendNodeId?: number[]
    attributes?: ArrayOfStrings[]
    textValue?: StringIndex[]
    inputValue?: StringIndex[]
    inputChecked?: RareBooleanData
    optionSelected?: RareBooleanData
    contentDocumentIndex?: number[]
    pseudoElementIndexes?: ArrayOfArrayOfIntegers[]
    layoutNodeIndex?: number[]
    isClickable?: RareBooleanData
    currentSourceURL?: StringIndex[]
    originURL?: StringIndex[]
  }

  export interface LayoutTreeSnapshot {
    nodeIndex: number[]
    bounds: number[][]
    text?: StringIndex[]
    paintOrders?: number[]
    offsetRects?: number[][]
    scrollRects?: number[][]
    clientRects?: number[][]
    blendedBackgroundColors?: StringIndex[]
    textColorOpacities?: number[]
    styles?: ArrayOfStrings[]
    stackingContexts?: RareBooleanData
  }

  export interface TextBoxSnapshot {
    layoutIndex: number[]
    bounds: number[][]
    start: number[]
    length: number[]
  }

  export interface DocumentSnapshot {
    documentURL: number
    title: number
    baseURL: number
    contentLanguage: number
    encodingName: number
    publicId: number
    systemId: number
    frameId: number
    nodes: NodeTreeSnapshot
    layout: LayoutTreeSnapshot
    textBoxes: TextBoxSnapshot
    scrollOffsetX?: number
    scrollOffsetY?: number
    contentWidth?: number
    contentHeight?: number
  }

  export interface CaptureSnapshotResponse {
    documents: DocumentSnapshot[]
    strings: string[]
  }

  export type StringIndex = number
  export type ArrayOfStrings = StringIndex[]
  export type ArrayOfArrayOfIntegers = number[][]
}

export namespace DOM {
  export interface GetDocumentParams {
    depth?: number
    pierce?: boolean
  }

  export interface Node {
    nodeId: number
    parentId?: number
    backendNodeId: number
    nodeType: number
    nodeName: string
    localName: string
    nodeValue: string
    childNodeCount?: number
    children?: Node[]
    attributes?: string[]
    documentURL?: string
    baseURL?: string
    publicId?: string
    systemId?: string
    internalSubset?: string
    xmlVersion?: string
    name?: string
    value?: string
    contentDocument?: Node
    shadowRoots?: Node[]
    shadowRootType?: "user-agent" | "open" | "closed"
    pseudoElements?: Node[]
    pseudoType?: string
    frameId?: string
    isSVG?: boolean
    isScrollable?: boolean
  }

  export interface GetDocumentResponse {
    root: Node
  }
}

export namespace Accessibility {
  export interface GetFullAXTreeParams {
    depth?: number
    frameId?: string
  }

  export interface AXNode {
    nodeId: string
    backendDOMNodeId?: number
    ignored: boolean
    ignoredReasons?: AXProperty[]
    role?: AXValue
    chromeRole?: AXValue
    name?: AXValue
    description?: AXValue
    value?: AXValue
    properties?: AXProperty[]
    parentId?: string
    childIds?: string[]
    frameId?: string
  }

  export interface AXProperty {
    name: string
    value: AXValue
  }

  export interface AXValue {
    type: string
    value?: any
    relatedNodes?: AXRelatedNode[]
    sources?: AXValueSource[]
  }

  export interface AXRelatedNode {
    backendDOMNodeId: number
    idref?: string
    text?: string
  }

  export interface AXValueSource {
    type: string
    value?: AXValue
    attribute?: string
    attributeValue?: AXValue
    superseded?: boolean
    nativeSource?: string
    nativeSourceValue?: AXValue
    invalid?: boolean
    invalidReason?: string
  }

  export interface GetFullAXTreeResponse {
    nodes: AXNode[]
  }
}

export namespace Page {
  export interface LayoutViewport {
    pageX: number
    pageY: number
    clientWidth: number
    clientHeight: number
  }

  export interface VisualViewport {
    offsetX: number
    offsetY: number
    pageX: number
    pageY: number
    clientWidth: number
    clientHeight: number
    scale: number
    zoom?: number
  }

  export interface CSSVisualViewport {
    offsetX: number
    offsetY: number
    pageX: number
    pageY: number
    clientWidth: number
    clientHeight: number
    scale: number
    zoom?: number
  }

  export interface CSSLayoutViewport {
    pageX: number
    pageY: number
    clientWidth: number
    clientHeight: number
  }

  export interface GetLayoutMetricsResponse {
    layoutViewport: LayoutViewport
    visualViewport: VisualViewport
    contentSize: {
      x: number
      y: number
      width: number
      height: number
    }
    cssContentSize?: {
      x: number
      y: number
      width: number
      height: number
    }
    cssVisualViewport?: CSSVisualViewport
    cssLayoutViewport?: CSSLayoutViewport
  }

  export interface FrameTree {
    frame: Frame
    childFrames?: FrameTree[]
  }

  export interface Frame {
    id: string
    parentId?: string
    loaderId: string
    name?: string
    url: string
    urlFragment?: string
    domainAndRegistry?: string
    securityOrigin: string
    mimeType: string
    unreachableUrl?: string
  }

  export interface GetFrameTreeResponse {
    frameTree: FrameTree
  }
}

export namespace Target {
  export type TargetID = string
  export type SessionID = string

  export interface TargetInfo {
    targetId: TargetID
    type: string
    title: string
    url: string
    attached: boolean
    openerId?: TargetID
    canAccessOpener: boolean
    openerFrameId?: string
    browserContextId?: string
    subtype?: string
  }

  export interface AttachedToTargetEvent {
    sessionId: SessionID
    targetInfo: TargetInfo
    waitingForDebugger: boolean
  }

  export interface SetAutoAttachParams {
    autoAttach: boolean
    waitForDebuggerOnStart: boolean
    flatten: boolean
  }

  export interface GetFrameOwnerResponse {
    backendNodeId: number
    nodeId?: number
  }
}

export namespace Runtime {
  export interface EvaluateParams {
    expression: string
    objectGroup?: string
    includeCommandLineAPI?: boolean
    silent?: boolean
    contextId?: number
    returnByValue?: boolean
    generatePreview?: boolean
    userGesture?: boolean
    awaitPromise?: boolean
    throwOnSideEffect?: boolean
    timeout?: number
    disableBreaks?: boolean
    replMode?: boolean
    allowUnsafeEvalBlockedByCSP?: boolean
    uniqueContextId?: string
  }

  export interface EvaluateResponse {
    result: RemoteObject
    exceptionDetails?: ExceptionDetails
  }

  export interface RemoteObject {
    type: string
    subtype?: string
    className?: string
    value?: any
    unserializableValue?: string
    description?: string
    objectId?: string
    preview?: ObjectPreview
    customPreview?: CustomPreview
  }

  export interface ObjectPreview {
    type: string
    subtype?: string
    description?: string
    overflow: boolean
    properties: PropertyPreview[]
    entries?: EntryPreview[]
  }

  export interface PropertyPreview {
    name: string
    type: string
    value?: string
    valuePreview?: ObjectPreview
    subtype?: string
  }

  export interface EntryPreview {
    key?: ObjectPreview
    value: ObjectPreview
  }

  export interface CustomPreview {
    header: string
    bodyGetterId?: string
  }

  export interface ExceptionDetails {
    exceptionId: number
    text: string
    lineNumber: number
    columnNumber: number
    scriptId?: string
    url?: string
    stackTrace?: StackTrace
    exception?: RemoteObject
    executionContextId?: number
  }

  export interface StackTrace {
    description?: string
    callFrames: CallFrame[]
    parent?: StackTrace
    parentId?: StackTraceId
  }

  export interface CallFrame {
    functionName: string
    scriptId: string
    url: string
    lineNumber: number
    columnNumber: number
  }

  export interface StackTraceId {
    id: string
    debuggerId?: string
  }
}
