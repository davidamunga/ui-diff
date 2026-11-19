export default function Card({ title, children, footer, highlight = false }) {
  return (
    <section className={highlight ? 'card card-highlight' : 'card'}>
      {title && <h3 className="card-title">{title}</h3>}
      <div className="card-body">{children}</div>
      {footer && <div className="card-footer">{footer}</div>}
    </section>
  );
}
