import { useForm } from 'react-hook-form';
export function objSpread() {
  const { register } = useForm();
  const props = { ...register('email') };          // line 4
  return props;
}
export function jsxSpread() {
  const { register } = useForm();
  return <input {...register('email')} />;          // line 9
}
export function jsxSpreadNested() {
  const { register } = useForm();
  return <form><input {...register('email')} /></form>;   // line 13
}
export function controls() {
  const { register } = useForm();
  register('email');
  const { reg: register2 } = useForm();
  register2('email');
  const r = useForm().register;
  r('email');
  const { register: register3 } = useForm();
  return <input ref={register('x')} />;
}
