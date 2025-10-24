interface ViewToggleProps {
  view: 'table' | 'cards';
  onChange: (view: 'table' | 'cards') => void;
}

export const ViewToggle = ({ view, onChange }: ViewToggleProps) => {
  return (
    <div className="dropdown dropdown-end">
      <button tabIndex={0} className="btn btn-sm btn-ghost" type="button">
        <i className={`fa-solid ${view === 'cards' ? 'fa-th-large' : 'fa-list'}`} />
        View
        <i className="fa-solid fa-chevron-down text-xs" />
      </button>
      <ul
        tabIndex={0}
        className="dropdown-content menu bg-base-100 rounded-box z-10 w-52 p-2 shadow-lg border border-base-300"
      >
        <li>
          <button
            onClick={() => onChange('table')}
            className={view === 'table' ? 'active' : ''}
            type="button"
          >
            <i className="fa-solid fa-list" />
            Table View
          </button>
        </li>
        <li>
          <button
            onClick={() => onChange('cards')}
            className={view === 'cards' ? 'active' : ''}
            type="button"
          >
            <i className="fa-solid fa-th-large" />
            Card View
          </button>
        </li>
      </ul>
    </div>
  );
};
