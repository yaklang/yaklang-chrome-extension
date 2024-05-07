import Icon from "@ant-design/icons";
import { CustomIconComponentProps } from "@ant-design/icons/lib/components/Icon";
import React from "react";

interface IconProps extends CustomIconComponentProps {
  onClick: (e: React.MouseEvent) => void;
  ref?: any;
}

const X = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
  >
    <path
      d="M4 12L12 4M4 4L12 12"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
/**
 * @description Icon/Outline/x
 */
export const XIcon = (props: Partial<IconProps>) => {
  return <Icon component={X} {...props} />;
};

const Check = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
  >
    <path
      d="M3.33337 8.66669L6.00004 11.3334L12.6667 4.66669"
      stroke="#56C991"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
/**
 * @description Icon/Outline/check
 */
export const CheckIcon = (props: Partial<IconProps>) => {
  return <Icon component={Check} {...props} />;
};

const PencilAlt = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
  >
    <path
      d="M7.33329 3.33334H3.99996C3.26358 3.33334 2.66663 3.93029 2.66663 4.66667V12C2.66663 12.7364 3.26358 13.3333 3.99996 13.3333H11.3333C12.0697 13.3333 12.6666 12.7364 12.6666 12V8.66667M11.7238 2.39052C12.2445 1.86983 13.0887 1.86983 13.6094 2.39052C14.1301 2.91122 14.1301 3.75544 13.6094 4.27614L7.88557 10H5.99996L5.99996 8.11438L11.7238 2.39052Z"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
/**
 * @description Icon/Outline/pencil-alt
 */
export const PencilAltIcon = (props: Partial<IconProps>) => {
  return <Icon component={PencilAlt} {...props} />;
};

const Refresh = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
  >
    <path
      d="M2.66663 2.66669V6.00002H3.0543M13.292 7.33335C12.964 4.70248 10.7197 2.66669 7.99996 2.66669C5.76171 2.66669 3.84549 4.04547 3.0543 6.00002M3.0543 6.00002H5.99996M13.3333 13.3334V10H12.9456M12.9456 10C12.1544 11.9546 10.2382 13.3334 7.99996 13.3334C5.28021 13.3334 3.03595 11.2976 2.70789 8.66669M12.9456 10H9.99996"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
/**
 * @description Icon/Outline/refresh
 */
export const RefreshIcon = (props: Partial<IconProps>) => {
  return <Icon component={Refresh} {...props} />;
};

const Exit = () => (
  <svg
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M9.33333 6.66668C9.10226 6.78107 8.87965 6.90988 8.66667 7.0519C7.05869 8.12418 6 9.95027 6 12.0227C6 15.3239 8.68629 18 12 18C15.3137 18 18 15.3239 18 12.0227C18 9.95027 16.9413 8.12418 15.3333 7.0519C15.1204 6.90988 14.8977 6.78107 14.6667 6.66668M12 5.33334V10.6667"
      stroke="#F7544A"
      strokeLinecap="round"
    />
  </svg>
);
/**
 * @description 退出
 */
export const ExitIcon = (props: Partial<IconProps>) => {
  return <Icon component={Exit} {...props} />;
};

const PlusSm = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
  >
    <path
      d="M8 4V8M8 8V12M8 8H12M8 8L4 8"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
/**
 * @description Icon/Outline/plus-sm
 */
export const PlusSmIcon = (props: Partial<IconProps>) => {
  return <Icon component={PlusSm} {...props} />;
};

const Trash = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
  >
    <path
      d="M12.6666 4.66667L12.0884 12.7617C12.0386 13.4594 11.458 14 10.7585 14H5.24145C4.54193 14 3.96135 13.4594 3.91151 12.7617L3.33329 4.66667M6.66663 7.33333V11.3333M9.33329 7.33333V11.3333M9.99996 4.66667V2.66667C9.99996 2.29848 9.70148 2 9.33329 2H6.66663C6.29844 2 5.99996 2.29848 5.99996 2.66667V4.66667M2.66663 4.66667H13.3333"
      stroke="#F7544A"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
/**
 * @description Icon/Outline/trash
 */
export const TrashIcon = (props: Partial<IconProps>) => {
  return <Icon component={Trash} {...props} />;
};
