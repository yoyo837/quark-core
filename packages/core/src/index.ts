import { createElement as h, Fragment as OriginFragment } from './core/create-element'
import { render } from './core/render'
import { isFunction } from './core/util'
import { PropertyDeclaration, converterFunction } from "./models"
import DblKeyMap from "./dblKeyMap"
import { EventController, EventHandler } from "./eventController"
import {version} from '../package.json'
import { Dep, Watcher } from './computed';

export interface Ref<T = any> {
  current: T;
}

export function createRef<T = any>(): Ref<T | null> {
  return { current: null };
}

export const Fragment: any = OriginFragment;

if(process.env.NODE_ENV === 'development') {
  console.info(`%cquarkc@${version}`, 'color: white;background:#9f57f8;font-weight:bold;font-size:10px;padding:2px 6px;border-radius: 5px','Running in dev mode.')
}

const isEmpty = (val: unknown) => !(val || val === false || val === 0);

const defaultConverter: converterFunction = (value, type?) => {
  let newValue = value;
  switch (type) {
    case Number:
      newValue = isEmpty(value) ? value : Number(value);
      break;
    case Boolean:
      newValue = !([null, "false", false, undefined].indexOf(value) > -1);
      break;
  }
  return newValue;
};

const defaultPropertyDeclaration: PropertyDeclaration = {
  observed: true,
  type: String,
  converter: defaultConverter,
};

export const property = (options: PropertyDeclaration = {}) => {
  return (target: unknown, name: string) => {
    return (target as { constructor: typeof QuarkElement }).constructor.createProperty(
      name,
      options
    );
  };
};

export const state = () => {
  return (target: unknown, name: string) => {
    return (target as { constructor: typeof QuarkElement }).constructor.createState(name);
  };
};

export const computed = () => {
  return (target: unknown, propertyKey: string, descriptor: PropertyDescriptor) => {
    return (target as { constructor: typeof QuarkElement }).constructor.computed(
      propertyKey,
      descriptor,
    );
  };
};

export const watch = (path: string) => {
  return (target: unknown, propertyKey: string, descriptor: PropertyDescriptor) => {
    return (target as { constructor: typeof QuarkElement }).constructor.watch(
      propertyKey,
      descriptor,
      path,
    );
  };
}

const ElementProperties: DblKeyMap<
  typeof QuarkElement,
  string,
  PropertyDeclaration
> = new DblKeyMap();

const PropertyDepMap: DblKeyMap<
  typeof QuarkElement,
  string,
  Dep
> = new DblKeyMap();

type PropertyDescriptorCreator = (defaultValue?: any) => PropertyDescriptor

const Descriptors: DblKeyMap<
  typeof QuarkElement,
  string,
  PropertyDescriptorCreator
> = new DblKeyMap();

const ComputedDescriptors: DblKeyMap<
  typeof QuarkElement,
  string,
  PropertyDescriptorCreator
> = new DblKeyMap();

const UserWatchers: DblKeyMap<
  typeof QuarkElement,
  string,
  {
    path: string;
    cb: (newVal: any, oldVal: any) => void
  }
> = new DblKeyMap();

export function customElement(
  params: string | { tag: string; style?: string }
) {
  const { tag, style = "" } =
    typeof params === "string" ? { tag: params } : params;

  return (target: typeof QuarkElement) => {
    class NewQuarkElement extends target {
      static get observedAttributes() {
        const attributes: string[] = [];
        const targetProperties = ElementProperties.get(target);
        if (targetProperties) {
          targetProperties.forEach((elOption, elName) => {
            if (elOption.observed) {
              attributes.push(elName);
            }
          });
        }
        return attributes;
      }

      static isBooleanProperty(propKey: string) {
        let isBoolean = false;
        const targetProperties = ElementProperties.get(target);
        if (targetProperties) {
          targetProperties.forEach((elOption, elName) => {
            if (
              elOption.type === Boolean &&
              propKey === elName
            ) {
              isBoolean = true;
              return isBoolean;
            }
          });
        }
        
        return isBoolean;
      }

      constructor() {
        super();

        const shadowRoot = this.attachShadow({ mode: "open" });

        if (shadowRoot) {
          // Create Css
          if (typeof CSSStyleSheet === "function" && shadowRoot.adoptedStyleSheets) {
            // Use constructed style first
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(style);
            shadowRoot.adoptedStyleSheets = [sheet];
          } else {
            // Fallback
            const styleEl = document.createElement("style");
            styleEl.innerHTML = style;
            shadowRoot.append(styleEl);
          }
        }

        const comp = Object.getPrototypeOf(this.constructor);

        /**
         * 重写类的属性描述符，并重写属性初始值。
         * 注：由于子类的属性初始化晚于当前基类的构造函数，同名属性会导致属性描述符被覆盖，所以必须放在基类构造函数之后执行
         */
        const descriptors = Descriptors.get(comp);
        
        if (descriptors?.size) {
          descriptors.forEach((descriptorCreator, propKey) => {
            Object.defineProperty(
              this,
              propKey,
              descriptorCreator(this[propKey])
            );
          });
        }

        const computedDescriptors = ComputedDescriptors.get(comp)

        if (computedDescriptors?.size) {
          computedDescriptors.forEach((descriptorCreator, propKey) => {
            Object.defineProperty(
              this,
              propKey,
              descriptorCreator()
            );
          });
        }

        const watchers = UserWatchers.get(comp)

        if (watchers?.size) {
          watchers.forEach(({
            path,
            cb,
          }) => {
            new Watcher(this, path, false, cb);
          });
        }
      }
    }

    if (!customElements.get(tag)) {
      customElements.define(tag, NewQuarkElement);
    }
  };
}

export class QuarkElement extends HTMLElement {
  static h = h;
  static Fragment = Fragment;

  // 外部属性装饰器，抹平不同框架使用差异
  protected static getPropertyDescriptor(
    name: string,
    options: PropertyDeclaration,
    dep: Dep,
  ): (defaultValue?: any) => PropertyDescriptor {
    return (defaultValue?: any) => {
      return {
        get(this: QuarkElement): any {
          dep.depend()
          let val = this.getAttribute(name);

          if (!isEmpty(defaultValue)) {
            // 判断val是否为空值
            // const isEmpty = () => !(val || val === false || val === 0)
            // 当类型为非Boolean时，通过isEmpty方法判断val是否为空值
            // 当类型为Boolean时，在isEmpty判断之外，额外认定空字符串不为空值
            //
            // 条件表达式推导过程
            // 由：(options.type !== Boolean && isEmpty(val)) || (options.type === Boolean && isEmpty(val) && val !== '')
            // 变形为：isEmpty(val) && (options.type !== Boolean || (options.type === Boolean && val !== ''))
            // 其中options.type === Boolean显然恒等于true：isEmpty(val) && (options.type !== Boolean || (true && val !== ''))
            // 得出：isEmpty(val) && (options.type !== Boolean || val !== '')
            if (isEmpty(val) && (options.type !== Boolean || val !== "")) {
              return defaultValue;
            }
          }
          if (isFunction(options.converter)) {
            val = options.converter(val, options.type) as string;
          }
          return val;
        },
        set(this: QuarkElement, newValue: string | boolean | null) {
          let val = newValue;

          if (isFunction(options.converter)) {
            val = options.converter(newValue, options.type);
          }

          if (val) {
            if (typeof val === "boolean") {
              this.setAttribute(name, "");
            } else {
              this.setAttribute(name, val);
            }
          } else {
            this.removeAttribute(name);
          }
        },
        configurable: true,
        enumerable: true,
      };
    };
  }

  // 内部属性装饰器
  protected static getStateDescriptor(name: string): () => PropertyDescriptor {
    return (defaultValue?: any) => {
      let value = defaultValue;
      let dep: Dep | undefined;
      const getDep = () => dep || (dep = new Dep());
      return {
        get(this: QuarkElement): any {
          getDep().depend()
          return value;
        },
        set(this: QuarkElement, newValue: string | boolean | null) {
          const oldValue = value;

          if (Object.is(oldValue, newValue)) {
            return;
          }

          value = newValue;
          getDep().notify();
          this._render();

          if (isFunction(this.componentDidUpdate)) {
            this.componentDidUpdate(name, oldValue, newValue);
          }
        },
        configurable: true,
        enumerable: true,
      };
    };
  }

  static createProperty(name: string, options: PropertyDeclaration) {
    const newOpt = Object.assign({}, defaultPropertyDeclaration, options);
    const attributeName = options.attribute || name;
    ElementProperties.set(this, attributeName, newOpt);
    const dep = new Dep();
    PropertyDepMap.set(this, attributeName, dep);
    Descriptors.set(this, name, this.getPropertyDescriptor(attributeName, newOpt, dep));
  }

  static createState(name: string) {
    Descriptors.set(this, name, this.getStateDescriptor(name));
  }

  static computed(propertyKey: string, descriptor: PropertyDescriptor) {
    if (descriptor.get) {
      ComputedDescriptors.set(this, propertyKey, () => {
        let watcher: Watcher;
        return {
          configurable: true,
          enumerable: true,
          get(this: QuarkElement) {
            if (!watcher) {
              watcher = new Watcher(this, descriptor.get!, true);
            }

            watcher.dep.depend();
            return watcher.get();
          },
        };
      });
    }
  }

  static watch(propertyKey: string, descriptor: PropertyDescriptor, path: string) {
    const { value } = descriptor;

    if (typeof value === 'function') {
      UserWatchers.set(this, propertyKey, {
        path,
        cb: value,
      });
    }
  }

  private eventController: EventController = new EventController();

  private rootPatch = (newRootVNode: any) => {
    if (this.shadowRoot) {
      render(newRootVNode, this.shadowRoot);
    }
  };

  private _render() {
    const newRootVNode = this.render();

    if (newRootVNode) {
      this.rootPatch(newRootVNode);
    }
  }

  /** 对传入的值根据类型进行转换处理 */
  private _updateProperty() {
    (this.constructor as any).observedAttributes.forEach(
      (propKey: string) => {
        this[propKey] = this[propKey];
      }
    );
  }

  private _updateBooleanProperty(propKey: string) {
    // 判断是否是 boolean
    if ((this.constructor as any).isBooleanProperty(propKey)) {
      // 针对 false 场景走一次 set， true 不需要重新走 set
      if (!(this as any)[propKey]) {
        (this as any)[propKey] = (this as any)[propKey];
      }
    }
  }

  $on = (eventName: string, eventHandler: EventHandler, el?: Element) => {
    return this.eventController.bindListener(
      el || this,
      eventName,
      eventHandler
    );
  };

  $emit<T>(eventName: string, customEventInit?: CustomEventInit<T>) {
    return this.dispatchEvent(
      new CustomEvent(
        eventName,
        Object.assign({ bubbles: true }, customEventInit)
      )
    );
  }

  /**
   * 此时组件 dom 已插入到页面中，等同于 connectedCallback() { super.connectedCallback(); }
   */
  componentDidMount() {}

  /**
   * disconnectedCallback 触发时、dom 移除前执行，等同于 disconnectedCallback() { super.disconnectedCallback(); }
   */
  componentWillUnmount() {}

  /**
   * 控制当前属性变化是否导致组件渲染
   * @param propName 属性名
   * @param oldValue 属性旧值
   * @param newValue 属性新值
   * @returns boolean
   */
  shouldComponentUpdate(propName: string, oldValue: string, newValue: string) {
    return oldValue !== newValue;
  }

  componentDidUpdate(propName: string, oldValue: any, newValue: any) {}

  /**
   * 组件的 render 方法，
   * 自动执行 this.shadowRoot.innerHTML = this.render()
   * @returns VNode
   */
  render() {
    return "" as any;
  }

  private _initialRender = true

  connectedCallback() {
    this._updateProperty();

    /**
     * 初始值重写后首次渲染
     */
    this._render();
    this._initialRender = false;

    if (isFunction(this.componentDidMount)) {
      this.componentDidMount();
    }
  }

  attributeChangedCallback(name: string, oldValue: string, value: string) {
    if (this._initialRender) {
      return;
    }
    
    const newValue = this[name] || value;
    PropertyDepMap
      .get(Object.getPrototypeOf(this.constructor))
      ?.get(name)
      ?.notify();

    if (isFunction(this.shouldComponentUpdate)) {
      if (!this.shouldComponentUpdate(name, oldValue, newValue)) {
        return;
      }
    }

    this._render();

    if (isFunction(this.componentDidUpdate)) {
      this.componentDidUpdate(name, oldValue, newValue);
    }

    // 因为 React的属性变更并不会触发set，此时如果boolean值变更，这里的value会是字符串，组件内部通过get操作可以正常判断类型，但css里面有根据boolean属性设置样式的将会出现问题
    if (value !== oldValue) {
      // boolean 重走set
      this._updateBooleanProperty(name);
    }
  }

  disconnectedCallback() {
    if (isFunction(this.componentWillUnmount)) {
      this.componentWillUnmount();
    }

    this.eventController.removeAllListener();
    this.rootPatch(null);
    this._initialRender = true;
  }
}
